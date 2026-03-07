/**
 * Node.js fs 模块
 * 基于 CModuleFS 和 CModuleAsyncFS 实现
 */

export * from './constants';
export * from './sync';
export * from './callbacks';

import * as promises from './promises';
export { promises };

import * as fs from './index';
export default fs;
