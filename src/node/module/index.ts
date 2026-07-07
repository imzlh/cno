export * from './mod';

import { Module } from './mod';
import * as mod from './mod';

const moduleDefault = Module as typeof Module & typeof mod;

for (const key of Object.keys(mod)) {
    if (key in moduleDefault) continue;
    const desc = Object.getOwnPropertyDescriptor(mod, key);
    if (desc) Object.defineProperty(moduleDefault, key, desc);
}

export default moduleDefault;
