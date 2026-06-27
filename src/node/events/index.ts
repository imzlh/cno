export * from './mod';

// default re-export
import { EventEmitter } from './mod';
import * as ev from './mod';
export default Object.assign(EventEmitter, ev);