import type { MessagesBody } from '../../routing/messages-body.js';

/**
 * Shallow Anthropic Messages → OpenAI Chat Completions translation.
 *
 * "Shallow" is a contract, not a shortcut: anything without a faithful 1:1
 * mapping (images, documents, server tools, tool search references) throws
 * NotTranslatableError, and the request goes to the primary provider instead
 * of reaching the cheap model with half its context silently missing.
 */
export class NotTranslatableError extends Error {
  override readonly name = 'NotTranslatableError';
}

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export type ChatMessage =
  | { readonly role: 'system' | 'user'; readonly content: string }
  | { readonly role: 'assistant'; readonly content: string | null; readonly tool_calls?: ChatToolCall[] }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

export interface ChatTool {
  readonly type: 'function';
  readonly function: { readonly name: string; readonly description?: string; readonly parameters: unknown };
}

export type ChatToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly max_tokens: number;
  readonly stream: boolean;
  readonly stream_options?: { include_usage: true };
  readonly tools?: ChatTool[];
  readonly tool_choice?: ChatToolChoice;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: string[];
}

export interface TranslateOptions {
  readonly model: string;
  readonly maxOutputTokens: number;
}

type Block = { readonly type: string } & Readonly<Record<string, unknown>>;

const asBlocks = (content: unknown): Block[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : (content as Block[]);

function textOf(block: Block): string {
  if (typeof block['text'] !== 'string') throw new NotTranslatableError('text block without text');
  return block['text'];
}

function toolResultText(block: Block): string {
  const content = block['content'];
  const text =
    content === undefined
      ? ''
      : asBlocks(content)
          .map((b) => {
            if (b.type !== 'text') throw new NotTranslatableError(`tool_result content: ${b.type}`);
            return textOf(b);
          })
          .join('\n');
  return block['is_error'] === true ? `Error: ${text}` : text;
}

function translateSystem(system: unknown): ChatMessage[] {
  if (system === undefined) return [];
  const text = asBlocks(system)
    // Claude Code's notice that a server/deferred tool became available; those tools are not exposed here.
    .filter((b) => b.type !== 'tool_addition')
    .map((b) => {
      if (b.type !== 'text') throw new NotTranslatableError(`system block: ${b.type}`);
      return textOf(b);
    })
    .join('\n\n');
  return text ? [{ role: 'system', content: text }] : [];
}

function translateUser(content: unknown): ChatMessage[] {
  // OpenAI requires tool results immediately after the assistant's tool_calls,
  // so they are emitted before any text the same user turn carries.
  const toolMessages: ChatMessage[] = [];
  const texts: string[] = [];
  for (const block of asBlocks(content)) {
    if (block.type === 'tool_result') {
      toolMessages.push({ role: 'tool', tool_call_id: String(block['tool_use_id']), content: toolResultText(block) });
    } else if (block.type === 'text') {
      texts.push(textOf(block));
    } else {
      throw new NotTranslatableError(`user block: ${block.type}`);
    }
  }
  return texts.length > 0 ? [...toolMessages, { role: 'user', content: texts.join('\n') }] : toolMessages;
}

function translateAssistant(content: unknown): ChatMessage {
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const block of asBlocks(content)) {
    switch (block.type) {
      case 'text':
        texts.push(textOf(block));
        break;
      case 'tool_use':
        toolCalls.push({
          id: String(block['id']),
          type: 'function',
          function: { name: String(block['name']), arguments: JSON.stringify(block['input'] ?? {}) },
        });
        break;
      case 'thinking':
      case 'redacted_thinking':
        break; // model-bound reasoning: meaningless to another model, safe to drop
      default:
        throw new NotTranslatableError(`assistant block: ${block.type}`);
    }
  }
  const text = texts.join('\n') || null;
  return toolCalls.length > 0 ? { role: 'assistant', content: text, tool_calls: toolCalls } : { role: 'assistant', content: text };
}

function translateTools(tools: unknown): ChatTool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const fns = (tools as Block[])
    // Server tools (web search, tool search…) have no client-side schema, and
    // deferred tools are not meant to be in context until searched for.
    .filter((t) => t['input_schema'] !== undefined && t['defer_loading'] !== true)
    .map(
      (t): ChatTool => ({
        type: 'function',
        function: {
          name: String(t['name']),
          ...(typeof t['description'] === 'string' ? { description: t['description'] } : {}),
          parameters: t['input_schema'],
        },
      }),
    );
  return fns.length > 0 ? fns : undefined;
}

function translateToolChoice(choice: unknown): ChatToolChoice | undefined {
  if (!choice || typeof choice !== 'object') return undefined;
  const c = choice as Block;
  switch (c.type) {
    case 'auto':
      return 'auto';
    case 'none':
      return 'none';
    case 'any':
      return 'required';
    case 'tool':
      return { type: 'function', function: { name: String(c['name']) } };
    default:
      return undefined;
  }
}

export function toChatCompletion(body: MessagesBody, options: TranslateOptions): ChatCompletionRequest {
  const messages: ChatMessage[] = [...translateSystem(body['system'])];
  for (const message of body.messages) {
    if (message.role === 'user') messages.push(...translateUser(message.content));
    else if (message.role === 'assistant') messages.push(translateAssistant(message.content));
    else if (message.role === 'system') messages.push(...translateSystem(message.content));
    else throw new NotTranslatableError(`message role: ${message.role}`);
  }

  const tools = translateTools(body['tools']);
  const toolChoice = tools ? translateToolChoice(body['tool_choice']) : undefined;
  const stream = body['stream'] === true;
  const stop = body['stop_sequences'];

  return {
    model: options.model,
    messages,
    max_tokens: Math.min(body.max_tokens ?? options.maxOutputTokens, options.maxOutputTokens),
    stream,
    ...(stream ? { stream_options: { include_usage: true } as const } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(typeof body['temperature'] === 'number' ? { temperature: body['temperature'] } : {}),
    ...(typeof body['top_p'] === 'number' ? { top_p: body['top_p'] } : {}),
    ...(Array.isArray(stop) && stop.length > 0 ? { stop: stop as string[] } : {}),
  };
}
