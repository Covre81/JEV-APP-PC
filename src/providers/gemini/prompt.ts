import type { MessagesBody } from '../../routing/messages-body.js';

const SYSTEM_REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

export function renderGeminiPrompt(body: MessagesBody, maxChars: number): string | undefined {
  let preamble = "You are answering ONE turn of a conversation between a developer and a coding assistant. You have NO tools — do not try to read or write files, run commands or browse (any tool use is blocked and counts as failure). Answer the LAST user message using only the transcript. Reply in the same language the user writes in. Use Markdown. If a correct answer genuinely requires reading files not shown, running commands or editing files, reply with exactly JEV_NEEDS_TOOLS and nothing else.\n\n";

  let reminders = '';
  const messages: string[] = [];
  
  for (const m of body.messages) {
    if (m.role === 'system') continue;
    
    let text = `### ${m.role === 'user' ? 'User' : 'Assistant'}\n`;
    if (typeof m.content === 'string') {
      let content = m.content;
      if (m.role === 'user') {
        const matches = [...content.matchAll(SYSTEM_REMINDER)];
        for (const match of matches) {
           reminders += match[0].substring(0, 4000) + (match[0].length > 4000 ? '...\n' : '\n');
        }
        content = content.replace(SYSTEM_REMINDER, '').trim();
      }
      text += content + '\n\n';
    } else {
      for (const b of m.content) {
        if (b.type === 'text' && typeof b.text === 'string') {
          let content = b.text;
          if (m.role === 'user') {
             const matches = [...content.matchAll(SYSTEM_REMINDER)];
             for (const match of matches) {
                reminders += match[0].substring(0, 4000) + (match[0].length > 4000 ? '...\n' : '\n');
             }
             content = content.replace(SYSTEM_REMINDER, '').trim();
          }
          text += content + '\n';
        } else if (b.type === 'tool_use') {
          const input = JSON.stringify(b.input || {}).substring(0, 2000);
          text += `[assistant called tool ${(b as any).name} with input: ${input}]\n`;
        } else if (b.type === 'tool_result') {
          const content = typeof (b as any).content === 'string' ? (b as any).content : JSON.stringify((b as any).content || {});
          text += `[tool result: ${content.substring(0, 4000)}]\n`;
        } else if (b.type === 'image') {
          text += `[image omitted]\n`;
        } else if (b.type === 'document') {
          text += `[document omitted]\n`;
        }
      }
      text += '\n';
    }
    messages.push(text);
  }

  if (reminders) {
    preamble += "System reminders:\n" + reminders + "\n\n";
  }

  // Budget
  let prompt = preamble;
  const kept: string[] = [];
  let chars = preamble.length;
  
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (chars + msg.length > maxChars) {
      if (kept.length === 0) return undefined; // latest message alone doesn't fit
      kept.unshift("[earlier conversation omitted]\n\n");
      break;
    }
    chars += msg.length;
    kept.unshift(msg);
  }
  
  prompt += kept.join('');
  return prompt.trim();
}
