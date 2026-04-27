package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

const maxBufferedRequests = 200

const (
	digitsCharset = "0123456789"
	alnumCharset  = "0123456789abcdefghijklmnopqrstuvwxyz"
)

var tokenAttempts = []struct {
	charset string
	length  int
	tries   int
}{
	{digitsCharset, 4, 16},
	{alnumCharset, 4, 8},
	{alnumCharset, 5, 8},
	{alnumCharset, 6, 8},
}

type CapturedRequest struct {
	ID         string              `json:"id"`
	Timestamp  time.Time           `json:"timestamp"`
	RemoteAddr string              `json:"remote_addr"`
	Method     string              `json:"method"`
	URL        string              `json:"url"`
	Path       string              `json:"path"`
	RawQuery   string              `json:"raw_query"`
	Query      map[string][]string `json:"query"`
	Headers    map[string][]string `json:"headers"`
	Host       string              `json:"host"`
	Proto      string              `json:"proto"`
	Body       string              `json:"body"`
	BodySize   int                 `json:"body_size"`
	Truncated  bool                `json:"truncated"`
}

type Session struct {
	Token     string
	Port      int
	CreatedAt time.Time
	ExpiresAt time.Time

	listener net.Listener
	server   *http.Server
	maxBody  int64

	mu          sync.Mutex
	requests    []*CapturedRequest
	subscribers map[chan *CapturedRequest]struct{}
	done        chan struct{}
}

func (s *Session) capture(w http.ResponseWriter, r *http.Request) {
	limited := io.LimitReader(r.Body, s.maxBody+1)
	body, _ := io.ReadAll(limited)
	truncated := false
	if int64(len(body)) > s.maxBody {
		body = body[:s.maxBody]
		truncated = true
	}

	cr := &CapturedRequest{
		ID:         genID(),
		Timestamp:  time.Now(),
		RemoteAddr: r.RemoteAddr,
		Method:     r.Method,
		URL:        r.URL.String(),
		Path:       r.URL.Path,
		RawQuery:   r.URL.RawQuery,
		Query:      r.URL.Query(),
		Headers:    cloneHeaders(r.Header),
		Host:       r.Host,
		Proto:      r.Proto,
		Body:       string(body),
		BodySize:   len(body),
		Truncated:  truncated,
	}

	s.mu.Lock()
	s.requests = append(s.requests, cr)
	if len(s.requests) > maxBufferedRequests {
		s.requests = s.requests[len(s.requests)-maxBufferedRequests:]
	}
	for ch := range s.subscribers {
		select {
		case ch <- cr:
		default:
		}
	}
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Webreturn-Captured", "1")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"received":    true,
		"request_id":  cr.ID,
		"captured_at": cr.Timestamp,
	})
}

func (s *Session) Subscribe() chan *CapturedRequest {
	ch := make(chan *CapturedRequest, 32)
	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	return ch
}

func (s *Session) Unsubscribe(ch chan *CapturedRequest) {
	s.mu.Lock()
	delete(s.subscribers, ch)
	s.mu.Unlock()
}

func (s *Session) Snapshot() []*CapturedRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*CapturedRequest, len(s.requests))
	copy(out, s.requests)
	return out
}

func (s *Session) Done() <-chan struct{} {
	return s.done
}

func (s *Session) shutdown() {
	s.mu.Lock()
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.server.Shutdown(ctx)
}

type SessionManager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	maxBody  int64
}

func NewSessionManager(maxBody int64) *SessionManager {
	return &SessionManager{
		sessions: make(map[string]*Session),
		maxBody:  maxBody,
	}
}

func (m *SessionManager) Create(ttl time.Duration) (*Session, error) {
	listener, err := net.Listen("tcp", ":0")
	if err != nil {
		return nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port

	sess := &Session{
		Port:        port,
		CreatedAt:   time.Now(),
		ExpiresAt:   time.Now().Add(ttl),
		listener:    listener,
		maxBody:     m.maxBody,
		subscribers: make(map[chan *CapturedRequest]struct{}),
		done:        make(chan struct{}),
	}

	sess.server = &http.Server{
		Handler:           http.HandlerFunc(sess.capture),
		ReadHeaderTimeout: 10 * time.Second,
	}

	m.mu.Lock()
	tok := ""
loop:
	for _, a := range tokenAttempts {
		for i := 0; i < a.tries; i++ {
			t := randomString(a.charset, a.length)
			if _, exists := m.sessions[t]; !exists {
				tok = t
				break loop
			}
		}
	}
	if tok == "" {
		m.mu.Unlock()
		_ = listener.Close()
		return nil, errors.New("token 空间已满,稍后再试")
	}
	sess.Token = tok
	m.sessions[tok] = sess
	m.mu.Unlock()

	go func() {
		_ = sess.server.Serve(listener)
	}()

	return sess, nil
}

func (m *SessionManager) Get(token string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[token]
}

func (m *SessionManager) Cleanup(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := time.Now()
			var expired []*Session
			m.mu.Lock()
			for tok, s := range m.sessions {
				if now.After(s.ExpiresAt) {
					expired = append(expired, s)
					delete(m.sessions, tok)
				}
			}
			m.mu.Unlock()
			for _, s := range expired {
				s.shutdown()
			}
		}
	}
}

func (m *SessionManager) CloseAll() {
	m.mu.Lock()
	all := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.sessions = make(map[string]*Session)
	m.mu.Unlock()
	for _, s := range all {
		s.shutdown()
	}
}

func randomString(charset string, n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = charset[int(b[i])%len(charset)]
	}
	return string(out)
}

func genID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func cloneHeaders(h http.Header) map[string][]string {
	out := make(map[string][]string, len(h))
	for k, v := range h {
		c := make([]string, len(v))
		copy(c, v)
		out[k] = c
	}
	return out
}

func GetOutboundIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return ""
	}
	defer conn.Close()
	if a, ok := conn.LocalAddr().(*net.UDPAddr); ok {
		return a.IP.String()
	}
	return ""
}
