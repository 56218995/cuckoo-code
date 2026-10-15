/**
 * Cuckoo Code 工具 API（TypeScript 声明）
 *
 * 本文件描述 cuckoo 代码块中可以调用的全部全局函数与数据类型。
 * 运行时由 JsRunner 在受限沙箱中注入这些函数；本声明用于帮助
 * AI 理解调用方式，与运行时行为保持一致。
 *
 * 使用规则速览：
 * - 所有工具函数都是异步的，调用时必须写 await
 * - 相对路径基于全局变量 projectDir（当前项目根目录）解析
 * - 多行文本使用反引号（`）模板字符串，不需要任何转义
 * - 工具出错时抛出异常（Error.message 为错误描述），可用 try/catch 处理；
 *   唯一例外是 bash()/pwsh()：非零退出不抛异常，通过返回文本中的 [exit code] 标记报告
 * - 用 log() 输出中间过程；脚本最后可用 return 返回结果值
 *
 * ⚠️ 本文件由 scripts/build-tool-api.mjs 自动生成，请勿手动编辑。
 *    真相源：各工具的 apiMetas 元数据（src/tools/impl/*.ts）。
 */

/** 当前项目根目录（初始化项目后由系统注入）。未初始化时为 null。 */
declare const projectDir: string | null;

/**
 * 输出中间结果到执行日志（不中断脚本）。
 * 日志内容随执行结果一起回传给 AI。
 * 注意：log() 只在 cuckoo 代码块的 JS 层可用。不要在 bash()/pwsh() 的命令字符串内部调用它——那些命令是独立的 shell 脚本，无法访问 JS 函数。
 */
declare function log(...args: unknown[]): void;

// ================= 记忆 =================

/**
 * 把用户明确表达的偏好、习惯或长期有用的事实记入长期记忆（跨会话、跨项目保留）。后续对话会自动注入这些记忆。
 * @param text 要记住的内容（一句话，如"用户偏好用中文回复"）
 * @returns { id: string, message: string }
 * @throws 缺少窗口上下文或内容为空时抛出异常
 */
declare function remember(text: string): Promise<{ id: string, message: string }>;

/**
 * 按 id 删除一条长期记忆（当用户要求"忘掉"某事，或记忆已过时）。可用 listMemories 查看现有记忆及其 id。
 * @param id 要删除的记忆 id
 * @returns 确认消息
 * @throws id 为空或记忆不存在时抛出异常
 */
declare function forgetMemory(id: string): Promise<string>;
