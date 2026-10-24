import { InspectorSessionBase } from './session'
import type { ProtocolResponse } from './client'

export class Session extends InspectorSessionBase {
	async post(method: string, params?: Record<string, unknown>): Promise<ProtocolResponse> {
		return await this.postAsync(method, params)
	}
}

export { open, close, url, waitForDebugger, console } from './mod'
