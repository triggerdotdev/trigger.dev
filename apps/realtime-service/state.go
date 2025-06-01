package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
)

type RunState struct {
	ID        uuid.UUID              `json:"id"`
	EnvID     uuid.UUID              `json:"env_id"`
	Tags      []uuid.UUID            `json:"tags"`
	Status    string                 `json:"status"`
	UpdatedAt time.Time              `json:"updated_at"`
	CreatedAt time.Time              `json:"created_at"`
	Seq       uint64                 `json:"seq"`
	Data      map[string]interface{} `json:"data,omitempty"`
}

type StreamFilter struct {
	RunID     *uuid.UUID   `json:"run_id,omitempty"`
	EnvID     *uuid.UUID   `json:"env_id,omitempty"`
	Tags      []uuid.UUID  `json:"tags,omitempty"`
	CreatedAt *time.Time   `json:"created_at,omitempty"`
}

type Connection struct {
	Writer      http.ResponseWriter
	Filter      StreamFilter
	LastEventID string
	Events      chan *StreamEvent
	ID          uuid.UUID
	flusher     http.Flusher
}

type StreamEvent struct {
	ID   string      `json:"id"`
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

type StateManager struct {
	mu           sync.RWMutex
	runs         map[uuid.UUID]*RunState
	envIndex     map[uuid.UUID]map[uuid.UUID]struct{}
	tagIndex     map[uuid.UUID]map[uuid.UUID]struct{}
	connections  map[uuid.UUID]*Connection
	subByRun     map[uuid.UUID]map[uuid.UUID]struct{}
	subByTag     map[uuid.UUID]map[uuid.UUID]struct{}
	subByEnv     map[uuid.UUID]map[uuid.UUID]struct{}
	sequence     uint64
	recentEvents map[uuid.UUID][]*StreamEvent
}

func NewStateManager() *StateManager {
	return &StateManager{
		runs:         make(map[uuid.UUID]*RunState),
		envIndex:     make(map[uuid.UUID]map[uuid.UUID]struct{}),
		tagIndex:     make(map[uuid.UUID]map[uuid.UUID]struct{}),
		connections:  make(map[uuid.UUID]*Connection),
		subByRun:     make(map[uuid.UUID]map[uuid.UUID]struct{}),
		subByTag:     make(map[uuid.UUID]map[uuid.UUID]struct{}),
		subByEnv:     make(map[uuid.UUID]map[uuid.UUID]struct{}),
		recentEvents: make(map[uuid.UUID][]*StreamEvent),
	}
}

func (sm *StateManager) UpdateRun(run *RunState) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	sm.sequence++
	run.Seq = sm.sequence

	if existing, exists := sm.runs[run.ID]; exists {
		sm.removeFromIndexes(existing)
	}
	
	sm.runs[run.ID] = run
	sm.addToIndexes(run)

	sm.broadcastUpdate(run)
}

func (sm *StateManager) RemoveRun(runID uuid.UUID) {
	sm.mu.Lock()
	defer sm.mu.Unlock()

	if existing, exists := sm.runs[runID]; exists {
		sm.removeFromIndexes(existing)
		delete(sm.runs, runID)
		delete(sm.recentEvents, runID)
	}
}

func (sm *StateManager) addToIndexes(run *RunState) {
	if sm.envIndex[run.EnvID] == nil {
		sm.envIndex[run.EnvID] = make(map[uuid.UUID]struct{})
	}
	sm.envIndex[run.EnvID][run.ID] = struct{}{}

	for _, tag := range run.Tags {
		if sm.tagIndex[tag] == nil {
			sm.tagIndex[tag] = make(map[uuid.UUID]struct{})
		}
		sm.tagIndex[tag][run.ID] = struct{}{}
	}
}

func (sm *StateManager) removeFromIndexes(run *RunState) {
	if envRuns, exists := sm.envIndex[run.EnvID]; exists {
		delete(envRuns, run.ID)
		if len(envRuns) == 0 {
			delete(sm.envIndex, run.EnvID)
		}
	}

	for _, tag := range run.Tags {
		if tagRuns, exists := sm.tagIndex[tag]; exists {
			delete(tagRuns, run.ID)
			if len(tagRuns) == 0 {
				delete(sm.tagIndex, tag)
			}
		}
	}
}

func (sm *StateManager) broadcastUpdate(run *RunState) {
	event := &StreamEvent{
		ID:   fmt.Sprintf("%d", run.Seq),
		Type: "delta",
		Data: run,
	}

	events := sm.recentEvents[run.ID]
	if len(events) >= 128 {
		events = events[1:]
	}
	events = append(events, event)
	sm.recentEvents[run.ID] = events

	for _, conn := range sm.connections {
		if sm.matchesFilter(run, conn.Filter) {
			select {
			case conn.Events <- event:
			default:
			}
		}
	}
}

func (sm *StateManager) matchesFilter(run *RunState, filter StreamFilter) bool {
	if filter.RunID != nil && *filter.RunID != run.ID {
		return false
	}
	
	if filter.EnvID != nil && *filter.EnvID != run.EnvID {
		return false
	}
	
	if filter.CreatedAt != nil && run.CreatedAt.Before(*filter.CreatedAt) {
		return false
	}
	
	if len(filter.Tags) > 0 {
		hasMatchingTag := false
		for _, filterTag := range filter.Tags {
			for _, runTag := range run.Tags {
				if filterTag == runTag {
					hasMatchingTag = true
					break
				}
			}
			if hasMatchingTag {
				break
			}
		}
		if !hasMatchingTag {
			return false
		}
	}
	
	return true
}

func (sm *StateManager) GetMatchingRuns(filter StreamFilter) []*RunState {
	sm.mu.RLock()
	defer sm.mu.RUnlock()

	var runs []*RunState
	for _, run := range sm.runs {
		if sm.matchesFilter(run, filter) {
			runs = append(runs, run)
		}
	}
	return runs
}

func (sm *StateManager) AddConnection(conn *Connection) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	sm.connections[conn.ID] = conn
	
	if conn.Filter.RunID != nil {
		if sm.subByRun[*conn.Filter.RunID] == nil {
			sm.subByRun[*conn.Filter.RunID] = make(map[uuid.UUID]struct{})
		}
		sm.subByRun[*conn.Filter.RunID][conn.ID] = struct{}{}
	}
	
	if conn.Filter.EnvID != nil {
		if sm.subByEnv[*conn.Filter.EnvID] == nil {
			sm.subByEnv[*conn.Filter.EnvID] = make(map[uuid.UUID]struct{})
		}
		sm.subByEnv[*conn.Filter.EnvID][conn.ID] = struct{}{}
	}
	
	for _, tag := range conn.Filter.Tags {
		if sm.subByTag[tag] == nil {
			sm.subByTag[tag] = make(map[uuid.UUID]struct{})
		}
		sm.subByTag[tag][conn.ID] = struct{}{}
	}
}

func (sm *StateManager) RemoveConnection(conn *Connection) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	
	delete(sm.connections, conn.ID)
	
	if conn.Filter.RunID != nil {
		if subs, exists := sm.subByRun[*conn.Filter.RunID]; exists {
			delete(subs, conn.ID)
			if len(subs) == 0 {
				delete(sm.subByRun, *conn.Filter.RunID)
			}
		}
	}
	
	if conn.Filter.EnvID != nil {
		if subs, exists := sm.subByEnv[*conn.Filter.EnvID]; exists {
			delete(subs, conn.ID)
			if len(subs) == 0 {
				delete(sm.subByEnv, *conn.Filter.EnvID)
			}
		}
	}
	
	for _, tag := range conn.Filter.Tags {
		if subs, exists := sm.subByTag[tag]; exists {
			delete(subs, conn.ID)
			if len(subs) == 0 {
				delete(sm.subByTag, tag)
			}
		}
	}
}

func NewConnection(w http.ResponseWriter, filter StreamFilter, lastEventID string) *Connection {
	flusher, _ := w.(http.Flusher)
	return &Connection{
		Writer:      w,
		Filter:      filter,
		LastEventID: lastEventID,
		Events:      make(chan *StreamEvent, 256),
		ID:          uuid.New(),
		flusher:     flusher,
	}
}

func (c *Connection) SendEvent(event *StreamEvent) error {
	data := fmt.Sprintf("id: %s\nevent: %s\ndata: %s\n\n", 
		event.ID, event.Type, mustMarshalJSON(event.Data))
	
	_, err := c.Writer.Write([]byte(data))
	if err != nil {
		return err
	}
	
	if c.flusher != nil {
		c.flusher.Flush()
	}
	return nil
}

func (c *Connection) SendKeepAlive() error {
	_, err := c.Writer.Write([]byte(": keepalive\n\n"))
	if err != nil {
		return err
	}
	
	if c.flusher != nil {
		c.flusher.Flush()
	}
	return nil
}

func mustMarshalJSON(v interface{}) string {
	data, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(data)
}
