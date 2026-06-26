import { EventEmitter } from '../events'
import { isMainThread } from '../worker_threads'
import { InspectorProtocolClient, type ProtocolResponse } from './client'

type PostCallback = (error: Error | null, result?: ProtocolResponse) => void

export class Session extends EventEmitter {
	protected readonly client = new InspectorProtocolClient()
	protected connected = false

	constructor() {
		super()
		this.client.on('notification', (method: string, params: Record<string, unknown>) => this.emit(method, params))
		this.client.on('inspectorNotification', (message) => this.emit('inspectorNotification', message))
		this.client.on('error', (error: Error) => this.emit('error', error))
	}

	connect(): void {
		this.connected = true
		this.client.connect(false, false)
	}

	connectToMainThread(): void {
		if (isMainThread) throw new Error('Session.connectToMainThread() is only available from a worker thread')
		this.connect()
	}

	disconnect(): void {
		this.client.disconnect()
		this.connected = false
	}

	post(method: string, callback?: PostCallback): void
	post(method: string, params?: Record<string, unknown>, callback?: PostCallback): void
	post(method: string, paramsOrCallback?: Record<string, unknown> | PostCallback, maybeCallback?: PostCallback): void {
		const { params, callback } = normalizePostArgs(paramsOrCallback, maybeCallback)
		const send = this.client.post(method, params)
		if (!callback) {
			void send.catch((error) => this.emit('error', error))
			return
		}
		void send.then((result) => callback(null, result)).catch((error) => callback(error))
	}

	protected postAsync(method: string, params?: Record<string, unknown>): Promise<ProtocolResponse> {
		if (!this.connected) this.connect()
		return this.client.post(method, params)
	}

	protected connectAsync(waitForDebugger: boolean): Promise<void> {
		this.connected = true
		this.client.connect(waitForDebugger, false)
		return Promise.resolve()
	}
}

function normalizePostArgs(
	paramsOrCallback?: Record<string, unknown> | PostCallback,
	maybeCallback?: PostCallback,
): { params: Record<string, unknown> | undefined; callback: PostCallback | undefined } {
	if (typeof paramsOrCallback === 'function') {
		return { params: undefined, callback: paramsOrCallback }
	}
	return { params: paramsOrCallback, callback: maybeCallback }
}
