package main

import (
	"context"
	"embed"
	"flag"
	"html/template"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"
)

//go:embed templates/*.html
var templatesFS embed.FS

var (
	flagListen  = flag.String("listen", ":8080", "UI 服务监听地址")
	flagTTL     = flag.Duration("ttl", time.Hour, "默认会话有效期")
	flagMaxBody = flag.Int64("max-body", 1<<20, "单个请求最大记录 body 字节数")
	flagHost    = flag.String("host", "", "对外公开主机名/IP(留空时根据访问 Host 推断)")
)

var (
	homeTmpl   *template.Template
	viewerTmpl *template.Template
	testTmpl   *template.Template
	manager    *SessionManager
)

func main() {
	flag.Parse()

	var err error
	homeTmpl, err = template.ParseFS(templatesFS, "templates/home.html")
	if err != nil {
		log.Fatalf("parse home template: %v", err)
	}
	viewerTmpl, err = template.ParseFS(templatesFS, "templates/viewer.html")
	if err != nil {
		log.Fatalf("parse viewer template: %v", err)
	}
	testTmpl, err = template.ParseFS(templatesFS, "templates/test.html")
	if err != nil {
		log.Fatalf("parse test template: %v", err)
	}

	manager = NewSessionManager(*flagMaxBody)

	mux := http.NewServeMux()
	mux.HandleFunc("/", homeHandler)
	mux.HandleFunc("/test", testHandler)
	mux.HandleFunc("/api/sessions", createSession)
	mux.HandleFunc("/api/proxy", proxyHandler)
	mux.HandleFunc("/v/", viewerPage)
	mux.HandleFunc("/api/sessions/", apiSession)

	srv := &http.Server{
		Addr:              *flagListen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("UI 服务监听 %s", *flagListen)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	go manager.Cleanup(ctx)

	<-ctx.Done()
	log.Println("收到退出信号,正在关闭...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	manager.CloseAll()
}
