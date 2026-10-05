import { Session } from './session'
import { console } from './console'
import { getInspectorBridge } from './state'

const disposeSymbol: symbol = (Symbol as typeof Symbol & { dispose?: symbol }).dispose ?? Symbol.for('Symbol.dispose')

export { Session, console }

export function open(port = 9229, host = '127.0.0.1', wait = false): { dispose(): void } {
	const bridge = requireBridge()
	void bridge.open({ port, host, wait })
	return {
		dispose(): void {
			close()
		},
		[disposeSymbol](): void {
			close()
		},
	}
}

export function close(): void {
	const bridge = getInspectorBridge()
	if (!bridge) return
	void bridge.close()
}

export function url(): string | undefined {
	return getInspectorBridge()?.url()
}

export function waitForDebugger(): void {
	const bridge = getInspectorBridge()
	if (!bridge?.isActive()) {
		throw Object.assign(new Error('Inspector is not active'), { code: 'ERR_INSPECTOR_NOT_ACTIVE' })
	}
	void bridge.waitForDebugger()
}

function requireBridge() {
	const bridge = getInspectorBridge()
	if (!bridge) throw new Error('Inspector bridge is not available in this runtime')
	return bridge
}

export default {
	open,
	close,
	url,
	waitForDebugger,
	console,
	Session,
}
