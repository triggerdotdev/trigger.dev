// NOTE: This file requires ES2020 or higher for BigInt literals (used in BinaryReader.readTime)
import { Client } from "pg";
import { types } from "pg";

export interface PgoutputOptions {
  protoVersion: 1 | 2;
  publicationNames: string[];
  messages?: boolean;
}

export type PgoutputMessage =
  | MessageBegin
  | MessageCommit
  | MessageDelete
  | MessageInsert
  | MessageMessage
  | MessageOrigin
  | MessageRelation
  | MessageTruncate
  | MessageType
  | MessageUpdate;

export interface MessageBegin {
  tag: "begin";
  commitLsn: string | null;
  commitTime: bigint;
  xid: number;
}
export interface MessageCommit {
  tag: "commit";
  flags: number;
  commitLsn: string | null;
  commitEndLsn: string | null;
  commitTime: bigint;
}
export interface MessageDelete {
  tag: "delete";
  relation: MessageRelation;
  key: Record<string, any> | null;
  old: Record<string, any> | null;
}
export interface MessageInsert {
  tag: "insert";
  relation: MessageRelation;
  new: Record<string, any>;
}
export interface MessageMessage {
  tag: "message";
  flags: number;
  transactional: boolean;
  messageLsn: string | null;
  prefix: string;
  content: Uint8Array;
}
export interface MessageOrigin {
  tag: "origin";
  originLsn: string | null;
  originName: string;
}
export interface MessageRelation {
  tag: "relation";
  relationOid: number;
  schema: string;
  name: string;
  replicaIdentity: "default" | "nothing" | "full" | "index";
  columns: RelationColumn[];
  keyColumns: string[];
}
export interface RelationColumn {
  name: string;
  flags: number;
  typeOid: number;
  typeMod: number;
  typeSchema: string | null;
  typeName: string | null;
  parser: (raw: any) => any;
}
export interface MessageTruncate {
  tag: "truncate";
  cascade: boolean;
  restartIdentity: boolean;
  relations: MessageRelation[];
}
export interface MessageType {
  tag: "type";
  typeOid: number;
  typeSchema: string;
  typeName: string;
}
export interface MessageUpdate {
  tag: "update";
  relation: MessageRelation;
  key: Record<string, any> | null;
  old: Record<string, any> | null;
  new: Record<string, any>;
}

class BinaryReader {
  private offset = 0;
  constructor(private buf: Buffer) {}
  readUint8(): number {
    return this.buf.readUInt8(this.offset++);
  }
  readInt16(): number {
    const v = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return v;
  }
  readInt32(): number {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }
  readString(): string {
    let end = this.buf.indexOf(0, this.offset);
    if (end === -1) throw new Error("Null-terminated string not found");
    const str = this.buf.toString("utf8", this.offset, end);
    this.offset = end + 1;
    return str;
  }
  read(len: number): Buffer {
    const b = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return b;
  }
  decodeText(buf: Buffer): string {
    return buf.toString("utf8");
  }
  array<T>(n: number, fn: () => T): T[] {
    return Array.from({ length: n }, fn);
  }

  readLsn(): string | null {
    const upper = this.readUint32();
    const lower = this.readUint32();
    if (upper === 0 && lower === 0) {
      return null;
    }
    return (
      upper.toString(16).padStart(8, "0").toUpperCase() +
      "/" +
      lower.toString(16).padStart(8, "0").toUpperCase()
    );
  }

  readUint32(): number {
    // >>> 0 ensures unsigned
    return this.readInt32() >>> 0;
  }

  readUint64(): bigint {
    // Combine two unsigned 32-bit ints into a 64-bit bigint
    return (BigInt(this.readUint32()) << 32n) | BigInt(this.readUint32());
  }

  readTime(): bigint {
    // (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * USECS_PER_DAY == 946684800000000
    const microsSinceUnixEpoch = this.readUint64() + 946684800000000n;
    return microsSinceUnixEpoch;
  }
}

export class PgoutputParser {
  private _typeCache = new Map<number, { typeSchema: string; typeName: string }>();
  private _relationCache = new Map<number, MessageRelation>();

  public parse(buf: Buffer): PgoutputMessage {
    const reader = new BinaryReader(buf);
    const tag = reader.readUint8();
    switch (tag) {
      case 0x42:
        return this.msgBegin(reader);
      case 0x4f:
        return this.msgOrigin(reader);
      case 0x59:
        return this.msgType(reader);
      case 0x52:
        return this.msgRelation(reader);
      case 0x49:
        return this.msgInsert(reader);
      case 0x55:
        return this.msgUpdate(reader);
      case 0x44:
        return this.msgDelete(reader);
      case 0x54:
        return this.msgTruncate(reader);
      case 0x4d:
        return this.msgMessage(reader);
      case 0x43:
        return this.msgCommit(reader);
      default:
        throw Error("unknown pgoutput message");
    }
  }

  private msgBegin(reader: BinaryReader): MessageBegin {
    return {
      tag: "begin",
      commitLsn: reader.readLsn(),
      commitTime: reader.readTime(),
      xid: reader.readInt32(),
    };
  }
  private msgOrigin(reader: BinaryReader): MessageOrigin {
    return {
      tag: "origin",
      originLsn: reader.readLsn(),
      originName: reader.readString(),
    };
  }
  private msgType(reader: BinaryReader): MessageType {
    const typeOid = reader.readInt32();
    const typeSchema = reader.readString();
    const typeName = reader.readString();
    this._typeCache.set(typeOid, { typeSchema, typeName });
    return { tag: "type", typeOid, typeSchema, typeName };
  }
  private msgRelation(reader: BinaryReader): MessageRelation {
    const relationOid = reader.readInt32();
    const schema = reader.readString();
    const name = reader.readString();
    const replicaIdentity = this.readRelationReplicaIdentity(reader);
    const columns = reader.array(reader.readInt16(), () => this.readRelationColumn(reader));
    const keyColumns = columns.filter((it) => it.flags & 0b1).map((it) => it.name);
    const msg: MessageRelation = {
      tag: "relation",
      relationOid,
      schema,
      name,
      replicaIdentity,
      columns,
      keyColumns,
    };
    this._relationCache.set(relationOid, msg);
    return msg;
  }
  private readRelationReplicaIdentity(reader: BinaryReader) {
    const ident = reader.readUint8();
    switch (ident) {
      case 0x64:
        return "default";
      case 0x6e:
        return "nothing";
      case 0x66:
        return "full";
      case 0x69:
        return "index";
      default:
        throw Error(`unknown replica identity ${String.fromCharCode(ident)}`);
    }
  }
  private readRelationColumn(reader: BinaryReader): RelationColumn {
    const flags = reader.readUint8();
    const name = reader.readString();
    const typeOid = reader.readInt32();
    const typeMod = reader.readInt32();
    return {
      flags,
      name,
      typeOid,
      typeMod,
      typeSchema: null,
      typeName: null,
      ...this._typeCache.get(typeOid),
      parser: types.getTypeParser(typeOid),
    };
  }
  private msgInsert(reader: BinaryReader): MessageInsert {
    const relation = this._relationCache.get(reader.readInt32());
    if (!relation) throw Error("missing relation");
    reader.readUint8(); // consume the 'N' key
    return {
      tag: "insert",
      relation,
      new: this.readTuple(reader, relation),
    };
  }
  private msgUpdate(reader: BinaryReader): MessageUpdate {
    const relation = this._relationCache.get(reader.readInt32());
    if (!relation) throw Error("missing relation");
    let key: Record<string, any> | null = null;
    let old: Record<string, any> | null = null;
    let new_: Record<string, any> | null = null;
    const subMsgKey = reader.readUint8();
    if (subMsgKey === 0x4b) {
      key = this.readKeyTuple(reader, relation);
      reader.readUint8();
      new_ = this.readTuple(reader, relation);
    } else if (subMsgKey === 0x4f) {
      old = this.readTuple(reader, relation);
      reader.readUint8();
      new_ = this.readTuple(reader, relation, old);
    } else if (subMsgKey === 0x4e) {
      new_ = this.readTuple(reader, relation);
    } else {
      throw Error(`unknown submessage key ${String.fromCharCode(subMsgKey)}`);
    }
    return { tag: "update", relation, key, old, new: new_ };
  }
  private msgDelete(reader: BinaryReader): MessageDelete {
    const relation = this._relationCache.get(reader.readInt32());
    if (!relation) throw Error("missing relation");
    let key: Record<string, any> | null = null;
    let old: Record<string, any> | null = null;
    const subMsgKey = reader.readUint8();
    if (subMsgKey === 0x4b) {
      key = this.readKeyTuple(reader, relation);
    } else if (subMsgKey === 0x4f) {
      old = this.readTuple(reader, relation);
    } else {
      throw Error(`unknown submessage key ${String.fromCharCode(subMsgKey)}`);
    }
    return { tag: "delete", relation, key, old };
  }
  private readKeyTuple(reader: BinaryReader, relation: MessageRelation): Record<string, any> {
    const tuple = this.readTuple(reader, relation);
    const key = Object.create(null);
    for (const k of relation.keyColumns) {
      key[k] = tuple[k] === null ? undefined : tuple[k];
    }
    return key;
  }
  private readTuple(
    reader: BinaryReader,
    { columns }: MessageRelation,
    unchangedToastFallback?: Record<string, any> | null
  ): Record<string, any> {
    const nfields = reader.readInt16();
    const tuple = Object.create(null);
    for (let i = 0; i < nfields; i++) {
      const { name, parser } = columns[i];
      const kind = reader.readUint8();
      switch (kind) {
        case 0x62: // 'b' binary
          const bsize = reader.readInt32();
          const bval = reader.read(bsize);
          tuple[name] = bval;
          break;
        case 0x74: // 't' text
          const valsize = reader.readInt32();
          const valbuf = reader.read(valsize);
          const valtext = reader.decodeText(valbuf);
          tuple[name] = parser(valtext);
          break;
        case 0x6e: // 'n' null
          tuple[name] = null;
          break;
        case 0x75: // 'u' unchanged toast datum
          tuple[name] = unchangedToastFallback?.[name];
          break;
        default:
          throw Error(`unknown attribute kind ${String.fromCharCode(kind)}`);
      }
    }
    return tuple;
  }
  private msgTruncate(reader: BinaryReader): MessageTruncate {
    const nrels = reader.readInt32();
    const flags = reader.readUint8();
    return {
      tag: "truncate",
      cascade: Boolean(flags & 0b1),
      restartIdentity: Boolean(flags & 0b10),
      relations: reader.array(
        nrels,
        () => this._relationCache.get(reader.readInt32()) as MessageRelation
      ),
    };
  }
  private msgMessage(reader: BinaryReader): MessageMessage {
    const flags = reader.readUint8();
    return {
      tag: "message",
      flags,
      transactional: Boolean(flags & 0b1),
      messageLsn: reader.readLsn(),
      prefix: reader.readString(),
      content: reader.read(reader.readInt32()),
    };
  }
  private msgCommit(reader: BinaryReader): MessageCommit {
    return {
      tag: "commit",
      flags: reader.readUint8(),
      commitLsn: reader.readLsn(),
      commitEndLsn: reader.readLsn(),
      commitTime: reader.readTime(),
    };
  }
}

export function getPgoutputStartReplicationSQL(
  slotName: string,
  lastLsn: string,
  options: PgoutputOptions
): string {
  const opts = [
    `proto_version '${options.protoVersion}'`,
    `publication_names '${options.publicationNames.join(",")}'`,
    `messages '${options.messages ?? false}'`,
  ];
  return `START_REPLICATION SLOT "${slotName}" LOGICAL ${lastLsn} (${opts.join(", ")});`;
}
