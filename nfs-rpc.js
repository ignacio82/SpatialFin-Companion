const net = require('net');

const AUTH_NULL = 0;
const IPPROTO_TCP = 6;
const RPC_VERSION = 2;
const REPLY_STAT_ACCEPTED = 0;
const ACCEPT_STAT_SUCCESS = 0;
const PMAPPROG = 100000;
const PMAPVERS = 2;
const PMAPPROC_GETPORT = 3;
const MOUNTPROG = 100005;
const MOUNTVERS = 3;
const MOUNTPROC_EXPORT = 5;

class XdrWriter {
  constructor() {
    this.parts = [];
  }

  writeUint32(value) {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    this.parts.push(buffer);
  }

  writeOpaque(value) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || '');
    this.writeUint32(buffer.length);
    if (buffer.length > 0) {
      this.parts.push(buffer);
      const padding = (4 - (buffer.length % 4)) % 4;
      if (padding > 0) {
        this.parts.push(Buffer.alloc(padding));
      }
    }
  }

  writeString(value) {
    this.writeOpaque(Buffer.from(String(value || ''), 'utf8'));
  }

  writeAuthNull() {
    this.writeUint32(AUTH_NULL);
    this.writeUint32(0);
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

class XdrReader {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readUint32() {
    if (this.offset + 4 > this.buffer.length) {
      throw new Error('Unexpected end of XDR data.');
    }
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value >>> 0;
  }

  readBoolean() {
    return this.readUint32() !== 0;
  }

  readOpaque() {
    const length = this.readUint32();
    if (this.offset + length > this.buffer.length) {
      throw new Error('Unexpected end of XDR opaque data.');
    }
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    this.offset += (4 - (length % 4)) % 4;
    return value;
  }

  readString() {
    return this.readOpaque().toString('utf8');
  }

  skipAuth() {
    this.readUint32();
    this.readOpaque();
  }
}

function buildRpcCall(program, version, procedure, body = Buffer.alloc(0)) {
  const xid = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  const writer = new XdrWriter();
  writer.writeUint32(xid);
  writer.writeUint32(0);
  writer.writeUint32(RPC_VERSION);
  writer.writeUint32(program);
  writer.writeUint32(version);
  writer.writeUint32(procedure);
  writer.writeAuthNull();
  writer.writeAuthNull();
  if (body.length > 0) {
    writer.parts.push(body);
  }

  const payload = writer.toBuffer();
  const frameHeader = Buffer.alloc(4);
  frameHeader.writeUInt32BE((payload.length | 0x80000000) >>> 0, 0);
  return Buffer.concat([frameHeader, payload]);
}

function parseRpcReply(buffer) {
  const reader = new XdrReader(buffer);
  reader.readUint32();

  const messageType = reader.readUint32();
  if (messageType !== 1) {
    throw new Error('Invalid RPC reply type.');
  }

  const replyStat = reader.readUint32();
  if (replyStat !== REPLY_STAT_ACCEPTED) {
    throw new Error(`RPC reply was denied (${replyStat}).`);
  }

  reader.skipAuth();

  const acceptStat = reader.readUint32();
  if (acceptStat !== ACCEPT_STAT_SUCCESS) {
    throw new Error(`RPC call failed with status ${acceptStat}.`);
  }

  return reader;
}

function sendRpcTcpRequest(host, port, program, version, procedure, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`RPC request to ${host}:${port} timed out.`));
    }, timeoutMs);

    let pending = Buffer.alloc(0);
    const fragments = [];

    function finish(error, value) {
      clearTimeout(timeout);
      socket.removeAllListeners();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.end();
        resolve(value);
      }
    }

    socket.once('connect', () => {
      socket.write(buildRpcCall(program, version, procedure, body));
    });

    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const header = pending.readUInt32BE(0);
        const isLastFragment = (header & 0x80000000) !== 0;
        const length = header & 0x7fffffff;
        if (pending.length < 4 + length) {
          return;
        }

        fragments.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);

        if (isLastFragment) {
          finish(null, Buffer.concat(fragments));
          return;
        }
      }
    });

    socket.once('error', (error) => {
      finish(error);
    });

    socket.once('end', () => {
      if (fragments.length === 0) {
        finish(new Error(`RPC server ${host}:${port} closed the connection without replying.`));
      }
    });
  });
}

async function queryRpcPort(host, program, version, protocol = IPPROTO_TCP, timeoutMs = 5000) {
  const bodyWriter = new XdrWriter();
  bodyWriter.writeUint32(program);
  bodyWriter.writeUint32(version);
  bodyWriter.writeUint32(protocol);
  bodyWriter.writeUint32(0);

  const reply = await sendRpcTcpRequest(
    host,
    111,
    PMAPPROG,
    PMAPVERS,
    PMAPPROC_GETPORT,
    bodyWriter.toBuffer(),
    timeoutMs
  );
  const reader = parseRpcReply(reply);
  return reader.readUint32();
}

function parseMountExports(reply) {
  const reader = parseRpcReply(reply);
  const exports = [];

  while (reader.readBoolean()) {
    const path = reader.readString();
    const groups = [];
    while (reader.readBoolean()) {
      groups.push(reader.readString());
    }
    exports.push({
      path,
      groups
    });
  }

  return exports;
}

async function queryNfsExportsViaRpc(host, timeoutMs = 5000) {
  const mountdPort = await queryRpcPort(host, MOUNTPROG, MOUNTVERS, IPPROTO_TCP, timeoutMs);
  if (!mountdPort) {
    throw new Error('Mount daemon is not registered with portmapper on the target host.');
  }

  const reply = await sendRpcTcpRequest(
    host,
    mountdPort,
    MOUNTPROG,
    MOUNTVERS,
    MOUNTPROC_EXPORT,
    Buffer.alloc(0),
    timeoutMs
  );

  return parseMountExports(reply);
}

module.exports = {
  queryNfsExportsViaRpc
};
