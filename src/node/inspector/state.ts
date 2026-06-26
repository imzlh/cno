const INSPECTOR_BRIDGE = Symbol.for('cno.inspector.bridge')

export interface InspectorBridge {
	open(options?: { port?: number; host?: string; wait?: boolean }): Promise<string>
	close(): Promise<void>
	url(): string | undefined
	waitForConnection(): Promise<void>
	waitForDebugger(): Promise<void>
	isActive(): boolean
}

export function getInspectorBridge(): InspectorBridge | null {
	const value = (globalThis as Record<PropertyKey, unknown>)[INSPECTOR_BRIDGE]
	if (!value || typeof value !== 'object') return null
	return value as InspectorBridge
}
