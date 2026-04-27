package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func homeHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	_ = homeTmpl.Execute(w, map[string]any{
		"DefaultTTL": flagTTL.String(),
	})
}

func testHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = testTmpl.Execute(w, nil)
}

func createSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ttl := *flagTTL
	if v := r.FormValue("ttl"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			ttl = d
		}
	}

	sess, err := manager.Create(ttl)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	http.Redirect(w, r, "/v/"+sess.Token, http.StatusSeeOther)
}

func viewerPage(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, "/v/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	sess := manager.Get(token)
	if sess == nil {
		http.Error(w, "会话不存在或已过期", http.StatusNotFound)
		return
	}

	host := strings.TrimSpace(*flagHost)
	if host == "" {
		host = hostFromRequest(r)
	}

	_ = viewerTmpl.Execute(w, map[string]any{
		"Token":     sess.Token,
		"Host":      host,
		"Port":      sess.Port,
		"URL":       fmt.Sprintf("http://%s:%d", host, sess.Port),
		"ExpiresAt": sess.ExpiresAt.Format(time.RFC3339),
		"ExpiresMs": sess.ExpiresAt.UnixMilli(),
	})
}

func hostFromRequest(r *http.Request) string {
	h := r.Host
	if i := strings.LastIndex(h, ":"); i != -1 {
		h = h[:i]
	}
	if h == "" || h == "localhost" || h == "127.0.0.1" || h == "::1" {
		if ip := GetOutboundIP(); ip != "" {
			return ip
		}
		if h == "" {
			return "127.0.0.1"
		}
	}
	return h
}

func apiSession(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) < 2 {
		http.NotFound(w, r)
		return
	}
	token, sub := parts[0], parts[1]
	sess := manager.Get(token)
	if sess == nil {
		http.NotFound(w, r)
		return
	}

	switch sub {
	case "events":
		sseHandler(w, r, sess)
	case "requests":
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(sess.Snapshot())
	default:
		http.NotFound(w, r)
	}
}

func sseHandler(w http.ResponseWriter, r *http.Request, sess *Session) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	for _, cr := range sess.Snapshot() {
		writeSSE(w, "request", cr)
	}
	flusher.Flush()

	ch := sess.Subscribe()
	defer sess.Unsubscribe(ch)

	keepalive := time.NewTicker(15 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case cr := <-ch:
			writeSSE(w, "request", cr)
			flusher.Flush()
		case <-keepalive.C:
			_, _ = fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-sess.Done():
			writeSSE(w, "expired", map[string]string{"reason": "会话已过期"})
			flusher.Flush()
			return
		case <-r.Context().Done():
			return
		}
	}
}

func writeSSE(w http.ResponseWriter, event string, data any) {
	b, err := json.Marshal(data)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
}
