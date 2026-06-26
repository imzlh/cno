import { Session as CallbackSession } from './session'
import { open, close, url, waitForDebugger, console } from './mod'

export class Session extends CallbackSession {
	// @ts-expect-error - Promise-based override of callback-based base.post()
	async post(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
		return await this.postAsync(method, params) as Record<string, unknown>
	}
}

export { open, close, url, waitForDebugger, console }

export default {
	open,
	close,
	url,
	waitForDebugger,
	console,
	Session,
}
