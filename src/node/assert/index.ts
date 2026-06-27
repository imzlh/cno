// re-export all exports
export * from './mod';

// default re-export
import { assert } from './mod';
import * as asserts from './mod';
export default Object.assign(assert, asserts);