export class FCastClient {
    constructor(ip, port) {
        this.ip = ip;
        this.port = port;
        this.ws = null;
        this.onMessage = null;
        this.onConnect = null;
        this.onDisconnect = null;
        this.onError = null;
    }

    connect() {
        this.ws = new WebSocket(`ws://${this.ip}:${this.port}`);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            if (this.onConnect) this.onConnect();
        };

        this.ws.onclose = () => {
            if (this.onDisconnect) this.onDisconnect();
        };

        this.ws.onerror = (err) => {
            if (this.onError) this.onError(err);
        };

        this.ws.onmessage = (event) => {
            try {
                let data = event.data;
                if (data instanceof ArrayBuffer) {
                    const view = new Uint8Array(data);
                    if (view.length === 0) return;
                    
                    const opcode = view[0];
                    let payload = null;
                    if (view.length > 1) {
                        const decoder = new TextDecoder();
                        const jsonStr = decoder.decode(view.subarray(1));
                        if (jsonStr.trim()) {
                            payload = JSON.parse(jsonStr);
                        }
                    }
                    if (this.onMessage) this.onMessage({ opcode, payload });
                } else if (typeof data === 'string') {
                    // Fallback in case messages are sent as strings
                    // Some servers might send just JSON without opcode for some reason
                    // but according to standard, we expect binary with opcode
                    console.log("Received string message", data);
                }
            } catch (err) {
                console.error("Error decoding FCast message", err);
            }
        };
    }

    sendMessage(opcode, payload = null) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            let payloadBytes = new Uint8Array(0);
            if (payload !== null) {
                const encoder = new TextEncoder();
                payloadBytes = encoder.encode(JSON.stringify(payload));
            }
            
            // Package message WITHOUT the 4-byte size header
            const message = new Uint8Array(1 + payloadBytes.length);
            message[0] = opcode;
            message.set(payloadBytes, 1);
            
            this.ws.send(message);
        } else {
            console.warn("WebSocket is not open");
        }
    }
    
    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

export async function fetchFCastReceivers() {
    try {
        const res = await fetch('/api/fcast/receivers');
        if (!res.ok) throw new Error("Failed to fetch receivers");
        return await res.json();
    } catch (err) {
        console.error(err);
        return [];
    }
}

export async function fetchFCastCredentials() {
    try {
        const res = await fetch('/api/auth/credentials');
        if (!res.ok) throw new Error("Failed to fetch credentials");
        return await res.json();
    } catch (err) {
        console.error(err);
        return null;
    }
}
