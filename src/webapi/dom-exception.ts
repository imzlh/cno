/**
 * `DOMException`, on its own so the large events.ts surface is not pulled in for
 * the type alone. events.ts imports this class, so `instanceof` holds across both.
 */
export class DOMException extends Error {
    public code: number;

    constructor(message: string = '', name: string = 'Error') {
        super(message);

        this.name = name;
        this.code = DOMException.getErrorCode(name);
        let stackValue = this.stack;
        Object.defineProperty(this, 'stack', {
            configurable: true,
            get() {
                return stackValue;
            },
            set(value) {
                stackValue = value;
            },
        });
    }

    // Static error code constants (as defined in DOM Standard)
    static readonly INDEX_SIZE_ERR: number = 1;
    static readonly DOMSTRING_SIZE_ERR: number = 2;
    static readonly HIERARCHY_REQUEST_ERR: number = 3;
    static readonly WRONG_DOCUMENT_ERR: number = 4;
    static readonly INVALID_CHARACTER_ERR: number = 5;
    static readonly NO_DATA_ALLOWED_ERR: number = 6;
    static readonly NO_MODIFICATION_ALLOWED_ERR: number = 7;
    static readonly NOT_FOUND_ERR: number = 8;
    static readonly NOT_SUPPORTED_ERR: number = 9;
    static readonly INUSE_ATTRIBUTE_ERR: number = 10;
    static readonly INVALID_STATE_ERR: number = 11;
    static readonly SYNTAX_ERR: number = 12;
    static readonly INVALID_MODIFICATION_ERR: number = 13;
    static readonly NAMESPACE_ERR: number = 14;
    static readonly INVALID_ACCESS_ERR: number = 15;
    static readonly VALIDATION_ERR: number = 16;
    static readonly TYPE_MISMATCH_ERR: number = 17;
    static readonly SECURITY_ERR: number = 18;
    static readonly NETWORK_ERR: number = 19;
    static readonly ABORT_ERR: number = 20;
    static readonly URL_MISMATCH_ERR: number = 21;
    static readonly QUOTA_EXCEEDED_ERR: number = 22;
    static readonly TIMEOUT_ERR: number = 23;
    static readonly INVALID_NODE_TYPE_ERR: number = 24;
    static readonly DATA_CLONE_ERR: number = 25;

    // Map error names to error codes
    private static errorCodeMap: Record<string, number> = {
        'IndexSizeError': DOMException.INDEX_SIZE_ERR,
        'DOMStringSizeError': DOMException.DOMSTRING_SIZE_ERR,
        'HierarchyRequestError': DOMException.HIERARCHY_REQUEST_ERR,
        'WrongDocumentError': DOMException.WRONG_DOCUMENT_ERR,
        'InvalidCharacterError': DOMException.INVALID_CHARACTER_ERR,
        'NoDataAllowedError': DOMException.NO_DATA_ALLOWED_ERR,
        'NoModificationAllowedError': DOMException.NO_MODIFICATION_ALLOWED_ERR,
        'NotFoundError': DOMException.NOT_FOUND_ERR,
        'NotSupportedError': DOMException.NOT_SUPPORTED_ERR,
        'InUseAttributeError': DOMException.INUSE_ATTRIBUTE_ERR,
        'InvalidStateError': DOMException.INVALID_STATE_ERR,
        'SyntaxError': DOMException.SYNTAX_ERR,
        'InvalidModificationError': DOMException.INVALID_MODIFICATION_ERR,
        'NamespaceError': DOMException.NAMESPACE_ERR,
        'InvalidAccessError': DOMException.INVALID_ACCESS_ERR,
        'ValidationError': DOMException.VALIDATION_ERR,
        'TypeMismatchError': DOMException.TYPE_MISMATCH_ERR,
        'SecurityError': DOMException.SECURITY_ERR,
        'NetworkError': DOMException.NETWORK_ERR,
        'AbortError': DOMException.ABORT_ERR,
        'URLMismatchError': DOMException.URL_MISMATCH_ERR,
        'QuotaExceededError': DOMException.QUOTA_EXCEEDED_ERR,
        'TimeoutError': DOMException.TIMEOUT_ERR,
        'InvalidNodeTypeError': DOMException.INVALID_NODE_TYPE_ERR,
        'DataCloneError': DOMException.DATA_CLONE_ERR,
        'Error': 0 // Default error
    };

    private static getErrorCode(name: string): number {
        return Object.prototype.hasOwnProperty.call(this.errorCodeMap, name)
            ? this.errorCodeMap[name] ?? 0
            : 0;
    }

    static create(name: string, message: string = ''): DOMException {
        return new DOMException(message, name);
    }

    static of(name: string, message?: string): DOMException {
        return new DOMException(message, name);
    }

    static indexSize(message?: string) { return DOMException.of('IndexSizeError', message); }
    static hierarchyRequest(message?: string) { return DOMException.of('HierarchyRequestError', message); }
    static notFound(message?: string) { return DOMException.of('NotFoundError', message); }
    static security(message?: string) { return DOMException.of('SecurityError', message); }
    static syntax(message?: string) { return DOMException.of('SyntaxError', message); }
    static typeMismatch(message?: string) { return DOMException.of('TypeMismatchError', message); }
    static invalidState(message?: string) { return DOMException.of('InvalidStateError', message); }

    get [Symbol.toStringTag]() {
        return 'DOMException';
    }
}
