package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
)

type ReplicationManager struct {
	config *Config
	state  *StateManager
	conn   *pgconn.PgConn
}

type TaskRunChange struct {
	Operation string                 `json:"operation"`
	Old       map[string]interface{} `json:"old,omitempty"`
	New       map[string]interface{} `json:"new,omitempty"`
	LSN       string                 `json:"lsn"`
}

func NewReplicationManager(config *Config, state *StateManager) *ReplicationManager {
	return &ReplicationManager{
		config: config,
		state:  state,
	}
}

func (rm *ReplicationManager) Start(ctx context.Context, databaseURL string) error {
	conn, err := pgconn.Connect(ctx, databaseURL)
	if err != nil {
		return fmt.Errorf("failed to connect for replication: %w", err)
	}
	rm.conn = conn

	if err := rm.ensurePublication(ctx); err != nil {
		return fmt.Errorf("failed to ensure publication: %w", err)
	}

	if err := rm.ensureReplicationSlot(ctx); err != nil {
		return fmt.Errorf("failed to ensure replication slot: %w", err)
	}

	return rm.startReplication(ctx)
}

func (rm *ReplicationManager) ensurePublication(ctx context.Context) error {
	checkSQL := `SELECT 1 FROM pg_publication WHERE pubname = $1`
	result := rm.conn.ExecParams(ctx, checkSQL, [][]byte{[]byte(rm.config.PublicationName)}, nil, nil, nil)
	
	var hasRows bool
	for result.NextRow() {
		hasRows = true
		break
	}
	result.Close()

	if !hasRows {
		createSQL := fmt.Sprintf(`CREATE PUBLICATION %s FOR TABLE "TaskRun" WITH (publish = 'insert,update,delete')`, 
			rm.config.PublicationName)
		
		result = rm.conn.ExecParams(ctx, createSQL, nil, nil, nil, nil)
		result.Close()
		
		log.Printf("Created publication: %s", rm.config.PublicationName)
	}

	alterSQL := `ALTER TABLE "TaskRun" REPLICA IDENTITY FULL`
	result = rm.conn.ExecParams(ctx, alterSQL, nil, nil, nil, nil)
	result.Close()

	return nil
}

func (rm *ReplicationManager) ensureReplicationSlot(ctx context.Context) error {
	checkSQL := `SELECT 1 FROM pg_replication_slots WHERE slot_name = $1`
	result := rm.conn.ExecParams(ctx, checkSQL, [][]byte{[]byte(rm.config.SlotName)}, nil, nil, nil)
	
	var hasRows bool
	for result.NextRow() {
		hasRows = true
		break
	}
	result.Close()

	if !hasRows {
		createSQL := fmt.Sprintf(`SELECT pg_create_logical_replication_slot('%s', 'pgoutput')`, 
			rm.config.SlotName)
		
		result = rm.conn.ExecParams(ctx, createSQL, nil, nil, nil, nil)
		result.Close()
		
		log.Printf("Created replication slot: %s", rm.config.SlotName)
	}

	return nil
}

func (rm *ReplicationManager) startReplication(ctx context.Context) error {
	startSQL := fmt.Sprintf(`START_REPLICATION SLOT %s LOGICAL 0/0 (proto_version '1', publication_names '%s')`,
		rm.config.SlotName, rm.config.PublicationName)

	if err := rm.conn.Exec(ctx, startSQL); err != nil {
		return fmt.Errorf("failed to start replication: %w", err)
	}

	log.Printf("Started logical replication on slot: %s", rm.config.SlotName)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
			msg, err := rm.conn.ReceiveMessage(ctx)
			if err != nil {
				return fmt.Errorf("failed to receive replication message: %w", err)
			}

			if err := rm.handleMessage(ctx, msg); err != nil {
				log.Printf("Error handling replication message: %v", err)
			}
		}
	}
}

func (rm *ReplicationManager) handleMessage(ctx context.Context, msg pgproto3.BackendMessage) error {
	switch m := msg.(type) {
	case *pgproto3.CopyData:
		return rm.handleCopyData(ctx, m.Data)
	case *pgproto3.ErrorResponse:
		return fmt.Errorf("replication error: %s", m.Message)
	}
	return nil
}

func (rm *ReplicationManager) handleCopyData(ctx context.Context, data []byte) error {
	if len(data) == 0 {
		return nil
	}

	msgType := data[0]
	
	switch msgType {
	case 'w': // XLogData
		return rm.handleXLogData(data[1:])
	case 'k': // Primary keepalive
		return rm.handleKeepalive(data[1:])
	}
	
	return nil
}

func (rm *ReplicationManager) handleXLogData(data []byte) error {
	if len(data) < 24 {
		return fmt.Errorf("XLogData too short")
	}

	walData := data[24:]
	
	return rm.parseLogicalMessage(walData)
}

func (rm *ReplicationManager) parseLogicalMessage(data []byte) error {
	if len(data) == 0 {
		return nil
	}

	msgType := data[0]
	
	switch msgType {
	case 'B': // Begin transaction
		return nil
	case 'C': // Commit transaction
		return nil
	case 'I': // Insert
		return rm.handleInsert(data[1:])
	case 'U': // Update
		return rm.handleUpdate(data[1:])
	case 'D': // Delete
		return rm.handleDelete(data[1:])
	}
	
	return nil
}

func (rm *ReplicationManager) handleInsert(data []byte) error {
	change, err := rm.parseChangeMessage("INSERT", data)
	if err != nil {
		return err
	}

	run, err := rm.changeToRunState(change)
	if err != nil {
		return err
	}

	rm.state.UpdateRun(run)
	return nil
}

func (rm *ReplicationManager) handleUpdate(data []byte) error {
	change, err := rm.parseChangeMessage("UPDATE", data)
	if err != nil {
		return err
	}

	run, err := rm.changeToRunState(change)
	if err != nil {
		return err
	}

	rm.state.UpdateRun(run)
	return nil
}

func (rm *ReplicationManager) handleDelete(data []byte) error {
	change, err := rm.parseChangeMessage("DELETE", data)
	if err != nil {
		return err
	}

	if change.Old != nil {
		run, err := rm.changeToRunState(change)
		if err != nil {
			return err
		}
		run.Status = "deleted"
		rm.state.UpdateRun(run)
	}

	return nil
}

func (rm *ReplicationManager) parseChangeMessage(operation string, data []byte) (*TaskRunChange, error) {
	change := &TaskRunChange{
		Operation: operation,
		New:       make(map[string]interface{}),
		Old:       make(map[string]interface{}),
	}

	if len(data) < 4 {
		return change, nil
	}

	pos := 0
	_ = uint32(data[pos])<<24 | uint32(data[pos+1])<<16 | uint32(data[pos+2])<<8 | uint32(data[pos+3])
	pos += 4

	if operation == "UPDATE" {
		pos++
	}

	tupleType := data[pos]
	pos++

	if tupleType != 'N' {
		return change, nil
	}

	if pos+2 >= len(data) {
		return change, nil
	}

	numCols := uint16(data[pos])<<8 | uint16(data[pos+1])
	pos += 2

	columnData := make(map[string]interface{})

	for i := uint16(0); i < numCols && pos < len(data); i++ {
		if pos >= len(data) {
			break
		}

		colType := data[pos]
		pos++

		if colType == 'n' {
			continue
		}

		if pos+4 >= len(data) {
			break
		}

		colLen := uint32(data[pos])<<24 | uint32(data[pos+1])<<16 | uint32(data[pos+2])<<8 | uint32(data[pos+3])
		pos += 4

		if pos+int(colLen) > len(data) {
			break
		}

		colData := string(data[pos : pos+int(colLen)])
		pos += int(colLen)

		switch i {
		case 0:
			columnData["id"] = colData
		case 1:
			columnData["runtime_environment_id"] = colData
		case 2:
			columnData["status"] = colData
		case 3:
			columnData["created_at"] = colData
		case 4:
			columnData["updated_at"] = colData
		case 5:
			columnData["tags"] = colData
		}
	}

	if operation == "DELETE" {
		change.Old = columnData
	} else {
		change.New = columnData
	}

	return change, nil
}

func (rm *ReplicationManager) changeToRunState(change *TaskRunChange) (*RunState, error) {
	var data map[string]interface{}
	if change.New != nil {
		data = change.New
	} else if change.Old != nil {
		data = change.Old
	} else {
		return nil, fmt.Errorf("no data in change")
	}

	run := &RunState{
		UpdatedAt: time.Now(),
		Data:      data,
	}

	if idStr, ok := data["id"].(string); ok {
		if id, err := uuid.Parse(idStr); err == nil {
			run.ID = id
		}
	}

	if envIDStr, ok := data["runtime_environment_id"].(string); ok {
		if envID, err := uuid.Parse(envIDStr); err == nil {
			run.EnvID = envID
		}
	}

	if status, ok := data["status"].(string); ok {
		run.Status = status
	}

	if createdAtStr, ok := data["created_at"].(string); ok {
		if createdAt, err := time.Parse(time.RFC3339, createdAtStr); err == nil {
			run.CreatedAt = createdAt
		}
	}

	if tagsData, ok := data["tags"]; ok {
		if tagsJSON, ok := tagsData.(string); ok {
			var tags []uuid.UUID
			if err := json.Unmarshal([]byte(tagsJSON), &tags); err == nil {
				run.Tags = tags
			}
		}
	}

	return run, nil
}

func (rm *ReplicationManager) handleKeepalive(data []byte) error {
	statusMsg := make([]byte, 34)
	statusMsg[0] = 'r'
	
	result := rm.conn.Exec(context.Background(), string(statusMsg))
	result.Close()
	return nil
}
