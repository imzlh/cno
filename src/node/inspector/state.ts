const INSPECTOR_BRIDGE = Symbol.for('cno.inspector.bridge')

export interface InspectorBridge {
	open(options?: { port?: number; host?: string; wait?: boolean }): Promise<string>
	close(): Promise<void>
	url(): string | undefined
	waitForConnection(): Promise<void>
	waitForDebugger(): Promise<void>
	isActive(): boolean
}

function isInspectorBridge(value: unknown): value is InspectorBridge {
	if (!value || typeof value !== 'object') return false
	return typeof Reflect.get(value, 'open') === 'function'
		&& typeof Reflect.get(value, 'close') === 'function'
		&& typeof Reflect.get(value, 'url') === 'function'
		&& typeof Reflect.get(value, 'waitForConnection') === 'function'
		&& typeof Reflect.get(value, 'waitForDebugger') === 'function'
		&& typeof Reflect.get(value, 'isActive') === 'function'
}

export function getInspectorBridge(): InspectorBridge | null {
	const value = Reflect.get(globalThis, INSPECTOR_BRIDGE)
	return isInspectorBridge(value) ? value : null
}
