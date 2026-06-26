import { EventEmitter } from '../events'
import { getInspectorBridge } from './state'

const engine = import.meta.use('engine');

export interface ProtocolResponse {
	[key: string]: unknown
}

interface PendingRequest {
	resolve: (value: ProtocolResponse) => void
	reject: (error: Error) => void
}

interface ProtocolMessage {
	id?: number
	method?: string
	params?: Record<string, unknown>
	result?: ProtocolResponse
	error?: { code?: number; message?: string }
}

export class InspectorProtocolClient extends EventEmitter {
	private ws: WebSocket | null = null
	private connectPromise: Promise<void> | null = null
	private nextId = 1
	private pending = new Map<number, PendingRequest>()

	connect(waitForDebugger: boolean, waitForConnect = true): void {
		const promise = this.ensureConnected(waitForDebugger)
		if (waitForConnect) void promise.catch((error) => this.emit('error', error))
	}

	disconnect(): void {
		try {
			this.ws?.close()
		} catch {}
		this.ws = null
		this.connectPromise = null
		this.failPending(new Error('Inspector session disconnected'))
	}

	post(method: string, params?: Record<string, unknown>): Promise<ProtocolResponse> {
		return this.ensureConnected(false).then(() => new Promise<ProtocolResponse>((resolve, reject) => {
			const ws = this.ws
			if (!ws || ws.readyState !== WebSocket.OPEN) {
				reject(new Error('Inspector session is not connected'))
				return
			}
			const id = this.nextId++
			this.pending.set(id, { resolve, reject })
			try {
				ws.send(JSON.stringify({ id, method, params }))
			} catch (error) {
				this.pending.delete(id)
				reject(asError(error))
			}
		}))
	}

	private ensureConnected(waitForDebugger: boolean): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
		if (this.connectPromise) return this.connectPromise

		const bridge = getInspectorBridge()
		if (!bridge) throw new Error('Inspector bridge is not available in this runtime')

		this.connectPromise = (async () => {
			const wsUrl = await bridge.open({ wait: waitForDebugger })
			await new Promise<void>((resolve, reject) => {
				const ws = new WebSocket(wsUrl)
				let settled = false
				const finish = (fn: () => void): void => {
					if (settled) return
					settled = true
					fn()
				}
				ws.onopen = () => finish(() => {
					this.ws = ws
					this.installSocket(ws)
					resolve()
				})
				ws.onerror = () => finish(() => reject(new Error('Failed to connect to inspector WebSocket')))
				ws.onclose = () => finish(() => reject(new Error('Inspector WebSocket closed before opening')))
			})
		})().finally(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) this.connectPromise = null
		})

		return this.connectPromise
	}

	private installSocket(ws: WebSocket): void {
		ws.onmessage = (event): void => {
			let raw = event.data
			if (raw instanceof ArrayBuffer) raw = engine.decodeString(new Uint8Array(raw))
			if (typeof raw !== 'string') return

			let message: ProtocolMessage
			try {
				message = JSON.parse(raw) as ProtocolMessage
			} catch {
				return
			}

			if (message.id != null) {
				const pending = this.pending.get(message.id)
				if (!pending) return
				this.pending.delete(message.id)
				if (message.error) pending.reject(new Error(message.error.message || 'Inspector protocol error'))
				else pending.resolve((message.result ?? {}) as ProtocolResponse)
				return
			}

			if (!message.method) return
			this.emit('notification', message.method, message.params ?? {})
			this.emit('inspectorNotification', message)
			this.emit(message.method, message.params ?? {})
		}

		ws.onclose = () => {
			this.ws = null
			this.connectPromise = null
			this.failPending(new Error('Inspector session disconnected'))
		}

		ws.onerror = () => {
			this.emit('error', new Error('Inspector WebSocket error'))
		}
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) pending.reject(error)
		this.pending.clear()
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error))
}
