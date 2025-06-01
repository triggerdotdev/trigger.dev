package main

import (
	"bytes"
	"encoding/gob"
	"fmt"
	"os"
	"time"

	"github.com/google/uuid"
	"github.com/klauspost/compress/zstd"
)

type Snapshot struct {
	Runs      map[uuid.UUID]*RunState `json:"runs"`
	LSN       string                  `json:"lsn"`
	Timestamp time.Time               `json:"timestamp"`
	Sequence  uint64                  `json:"sequence"`
}

type SnapshotManager struct {
	state    *StateManager
	filename string
}

func NewSnapshotManager(state *StateManager, filename string) *SnapshotManager {
	return &SnapshotManager{
		state:    state,
		filename: filename,
	}
}

func (sm *SnapshotManager) CreateSnapshot(lsn string) error {
	sm.state.mu.RLock()
	snapshot := &Snapshot{
		Runs:      make(map[uuid.UUID]*RunState),
		LSN:       lsn,
		Timestamp: time.Now(),
		Sequence:  sm.state.sequence,
	}
	
	for id, run := range sm.state.runs {
		snapshot.Runs[id] = run
	}
	sm.state.mu.RUnlock()

	var buf bytes.Buffer
	encoder := gob.NewEncoder(&buf)
	if err := encoder.Encode(snapshot); err != nil {
		return fmt.Errorf("failed to encode snapshot: %w", err)
	}

	compressor, err := zstd.NewWriter(nil)
	if err != nil {
		return fmt.Errorf("failed to create compressor: %w", err)
	}
	defer compressor.Close()

	compressed := compressor.EncodeAll(buf.Bytes(), nil)

	tempFile := sm.filename + ".tmp"
	if err := os.WriteFile(tempFile, compressed, 0644); err != nil {
		return fmt.Errorf("failed to write snapshot: %w", err)
	}

	if err := os.Rename(tempFile, sm.filename); err != nil {
		return fmt.Errorf("failed to rename snapshot: %w", err)
	}

	return nil
}

func (sm *SnapshotManager) LoadSnapshot() (*Snapshot, error) {
	data, err := os.ReadFile(sm.filename)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read snapshot: %w", err)
	}

	decompressor, err := zstd.NewReader(nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create decompressor: %w", err)
	}
	defer decompressor.Close()

	decompressed, err := decompressor.DecodeAll(data, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to decompress snapshot: %w", err)
	}

	var snapshot Snapshot
	decoder := gob.NewDecoder(bytes.NewReader(decompressed))
	if err := decoder.Decode(&snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode snapshot: %w", err)
	}

	return &snapshot, nil
}

func (sm *SnapshotManager) RestoreFromSnapshot(snapshot *Snapshot) {
	sm.state.mu.Lock()
	defer sm.state.mu.Unlock()

	sm.state.runs = snapshot.Runs
	sm.state.sequence = snapshot.Sequence

	sm.state.envIndex = make(map[uuid.UUID]map[uuid.UUID]struct{})
	sm.state.tagIndex = make(map[uuid.UUID]map[uuid.UUID]struct{})

	for _, run := range snapshot.Runs {
		sm.state.addToIndexes(run)
	}
}
