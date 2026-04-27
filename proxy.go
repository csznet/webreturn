package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxProxyBody    = 5 << 20 // 5 MiB
	proxyTimeout    = 30 * time.Second
	proxyDialTimeout = 10 * time.Second
)

type proxyRequest struct {
	Method  string     `json:"method"`
	URL     string     `json:"url"`
	Headers [][]string `json:"headers"`
	Body    string     `json:"body"`
}

type proxyResponse struct {
	Status     int        `json:"status"`
	StatusText string     `json:"status_text"`
	ElapsedMs  int64      `json:"elapsed_ms"`
	Headers    [][]string `json:"headers"`
	Body       string     `json:"body"`
	BodySize   int        `json:"body_size"`
	Truncated  bool       `json:"truncated"`
	Binary     bool       `json:"binary"`
	Error      string     `json:"error,omitempty"`
}

var hopByHop = map[string]struct{}{
	"host": {}, "connection": {}, "keep-alive": {},
	"proxy-authenticate": {}, "proxy-authorization": {},
	"te": {}, "trailers": {}, "transfer-encoding": {}, "upgrade": {},
	"content-length": {},
}

var blockedHostnames = map[string]struct{}{
	"localhost":                {},
	"metadata.google.internal": {},
	"metadata.azure.com":       {},
	"metadata":                 {},
}

var proxyClient = &http.Client{
	Timeout: proxyTimeout,
	Transport: &http.Transport{
		DialContext:           safeDialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: proxyTimeout,
		ExpectContinueTimeout: 1 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		MaxIdleConns:          16,
		ForceAttemptHTTP2:     true,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return nil
	},
}

func isPrivateIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	return ip.IsLoopback() || ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsUnspecified() || ip.IsMulticast() ||
		ip.IsInterfaceLocalMulticast()
}

func safeDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	d := &net.Dialer{Timeout: proxyDialTimeout}

	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return nil, fmt.Errorf("拒绝连接私网/本地 IP: %s", ip)
		}
		return d.DialContext(ctx, network, addr)
	}

	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if !isPrivateIP(ip) {
			return d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
		}
	}
	return nil, fmt.Errorf("所有解析 IP 都是私网/本地: %s", host)
}

func isAllowedURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("URL 不能为空")
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("仅支持 http / https")
	}
	if u.Host == "" {
		return "", errors.New("URL 缺少 host")
	}
	host := strings.ToLower(u.Hostname())
	if _, ok := blockedHostnames[host]; ok {
		return "", fmt.Errorf("拒绝访问主机: %s", host)
	}
	for _, suffix := range []string{".localhost", ".internal", ".local"} {
		if strings.HasSuffix(host, suffix) {
			return "", fmt.Errorf("拒绝访问主机: %s", host)
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		if isPrivateIP(ip) {
			return "", fmt.Errorf("拒绝访问私网/本地 IP: %s", ip)
		}
	}
	return u.String(), nil
}

func isTextContentType(ct string) bool {
	t := strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	if t == "" {
		return true
	}
	if strings.HasPrefix(t, "text/") {
		return true
	}
	switch t {
	case "application/json", "application/javascript", "application/xml",
		"application/x-www-form-urlencoded", "application/x-ndjson",
		"application/graphql":
		return true
	}
	return strings.HasSuffix(t, "+json") || strings.HasSuffix(t, "+xml")
}

func proxyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var pr proxyRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxProxyBody+8192)).Decode(&pr); err != nil {
		writeProxyJSON(w, http.StatusBadRequest, proxyResponse{Error: "请求 JSON 解析失败: " + err.Error()})
		return
	}

	target, err := isAllowedURL(pr.URL)
	if err != nil {
		writeProxyJSON(w, http.StatusOK, proxyResponse{Error: err.Error()})
		return
	}

	method := strings.ToUpper(strings.TrimSpace(pr.Method))
	if method == "" {
		method = "GET"
	}

	var bodyReader io.Reader
	if pr.Body != "" && method != http.MethodGet && method != http.MethodHead {
		bodyReader = strings.NewReader(pr.Body)
	}

	ctx, cancel := context.WithTimeout(r.Context(), proxyTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, method, target, bodyReader)
	if err != nil {
		writeProxyJSON(w, http.StatusOK, proxyResponse{Error: err.Error()})
		return
	}

	hasUA := false
	for _, kv := range pr.Headers {
		if len(kv) < 2 {
			continue
		}
		k := strings.TrimSpace(kv[0])
		if k == "" {
			continue
		}
		if _, hop := hopByHop[strings.ToLower(k)]; hop {
			continue
		}
		req.Header.Add(k, kv[1])
		if strings.EqualFold(k, "User-Agent") {
			hasUA = true
		}
	}
	if !hasUA {
		req.Header.Set("User-Agent", "webreturn-proxy/1.0")
	}

	start := time.Now()
	resp, err := proxyClient.Do(req)
	elapsed := time.Since(start).Milliseconds()
	if err != nil {
		writeProxyJSON(w, http.StatusOK, proxyResponse{Error: err.Error(), ElapsedMs: elapsed})
		return
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, maxProxyBody+1))
	truncated := false
	if len(raw) > maxProxyBody {
		raw = raw[:maxProxyBody]
		truncated = true
	}

	contentType := resp.Header.Get("Content-Type")
	binary := !isTextContentType(contentType)
	var bodyStr string
	if binary {
		bodyStr = base64.StdEncoding.EncodeToString(raw)
	} else {
		bodyStr = string(raw)
	}

	hdrs := make([][]string, 0, len(resp.Header))
	for k, vs := range resp.Header {
		for _, v := range vs {
			hdrs = append(hdrs, []string{k, v})
		}
	}

	writeProxyJSON(w, http.StatusOK, proxyResponse{
		Status:     resp.StatusCode,
		StatusText: resp.Status,
		ElapsedMs:  elapsed,
		Headers:    hdrs,
		Body:       bodyStr,
		BodySize:   len(raw),
		Truncated:  truncated,
		Binary:     binary,
	})
}

func writeProxyJSON(w http.ResponseWriter, status int, body proxyResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
