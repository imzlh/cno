/** Error text for diagnostics: message for Error instances, String() otherwise. */
export function errMsg(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
