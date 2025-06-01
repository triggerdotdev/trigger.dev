package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	DatabaseURL       string
	Port             string
	SlotName         string
	PublicationName  string
	RedisURL         string
	ConcurrencyLimit int
}

type Server struct {
	config          *Config
	pool            *pgxpool.Pool
	state           *StateManager
	replicator      *ReplicationManager
	redis           *redis.Client
	snapshotManager *SnapshotManager
	mu              sync.RWMutex
	isWarm          bool
	currentLSN      string
}

func main() {
	config := &Config{
		DatabaseURL:      getEnv("DATABASE_URL", "postgres://localhost/trigger_dev"),
		Port:            getEnv("PORT", "8080"),
		SlotName:        getEnv("REPLICATION_SLOT", "trigger_realtime_slot"),
		PublicationName: getEnv("PUBLICATION_NAME", "trigger_realtime_pub"),
		RedisURL:        getEnv("REDIS_URL", "redis://localhost:6379"),
		ConcurrencyLimit: getEnvInt("CONCURRENCY_LIMIT", 100000),
	}

	server, err := NewServer(config)
	if err != nil {
		log.Fatalf("Failed to create server: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		if err := server.StartReplication(ctx); err != nil {
			log.Printf("Replication error: %v", err)
		}
	}()

	http.HandleFunc("/v1/runs/stream", server.handleStream)
	http.HandleFunc("/health", server.handleHealth)

	log.Printf("Starting server on port %s", config.Port)
	
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	
	srv := &http.Server{
		Addr: ":" + config.Port,
	}
	
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	<-c
	log.Println("Shutting down server...")
	
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}
}

func NewServer(config *Config) (*Server, error) {
	pool, err := pgxpool.New(context.Background(), config.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	opt, err := redis.ParseURL(config.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to parse Redis URL: %w", err)
	}
	
	redisClient := redis.NewClient(opt)
	
	if err := redisClient.Ping(context.Background()).Err(); err != nil {
		return nil, fmt.Errorf("failed to connect to Redis: %w", err)
	}

	state := NewStateManager()
	replicator := NewReplicationManager(config, state)
	snapshotManager := NewSnapshotManager(state, "snapshot.dat")

	server := &Server{
		config:          config,
		pool:            pool,
		state:           state,
		replicator:      replicator,
		redis:           redisClient,
		snapshotManager: snapshotManager,
	}

	if snapshot, err := snapshotManager.LoadSnapshot(); err == nil && snapshot != nil {
		snapshotManager.RestoreFromSnapshot(snapshot)
		server.currentLSN = snapshot.LSN
		log.Printf("Restored from snapshot with %d runs, LSN: %s", len(snapshot.Runs), snapshot.LSN)
	}

	go server.snapshotWorker()

	return server, nil
}

func (s *Server) StartReplication(ctx context.Context) error {
	return s.replicator.Start(ctx, s.config.DatabaseURL)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"status": "ok",
		"warm":   s.isWarm,
		"time":   time.Now().UTC(),
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	if !s.checkConcurrencyLimit(r.Context()) {
		http.Error(w, "Too many concurrent connections", http.StatusTooManyRequests)
		return
	}
	defer s.decrementConcurrency(r.Context())

	filterParam := r.URL.Query().Get("filter")
	var filter StreamFilter
	if filterParam != "" {
		if err := json.Unmarshal([]byte(filterParam), &filter); err != nil {
			http.Error(w, "Invalid filter", http.StatusBadRequest)
			return
		}
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Last-Event-Id")

	lastEventID := r.Header.Get("Last-Event-Id")

	conn := NewConnection(w, filter, lastEventID)
	
	s.state.AddConnection(conn)
	defer s.state.RemoveConnection(conn)

	s.sendInitialState(conn)

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := conn.SendKeepAlive(); err != nil {
				return
			}
		case event := <-conn.Events:
			if err := conn.SendEvent(event); err != nil {
				log.Printf("Failed to send event: %v", err)
				return
			}
		}
	}
}

func (s *Server) sendInitialState(conn *Connection) {
	runs := s.state.GetMatchingRuns(conn.Filter)
	for _, run := range runs {
		event := &StreamEvent{
			ID:   fmt.Sprintf("%d", run.Seq),
			Type: "initial",
			Data: run,
		}
		select {
		case conn.Events <- event:
		default:
			return
		}
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func (s *Server) checkConcurrencyLimit(ctx context.Context) bool {
	current, err := s.redis.Incr(ctx, "realtime:connections").Result()
	if err != nil {
		log.Printf("Failed to increment connection count: %v", err)
		return true
	}
	
	if current > int64(s.config.ConcurrencyLimit) {
		s.redis.Decr(ctx, "realtime:connections")
		return false
	}
	
	return true
}

func (s *Server) decrementConcurrency(ctx context.Context) {
	if err := s.redis.Decr(ctx, "realtime:connections").Err(); err != nil {
		log.Printf("Failed to decrement connection count: %v", err)
	}
}

func (s *Server) snapshotWorker() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		if s.currentLSN != "" {
			if err := s.snapshotManager.CreateSnapshot(s.currentLSN); err != nil {
				log.Printf("Failed to create snapshot: %v", err)
			}
		}
	}
}
