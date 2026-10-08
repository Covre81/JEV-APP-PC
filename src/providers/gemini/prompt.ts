import type { MessagesBody } from '../../routing/messages-body.js';

const SYSTEM_REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

export function renderGeminiPrompt(body: MessagesBody, maxChars: number): string | undefined {
  const preambleText = "You are answering ONE turn of a conversation between a developer and a coding assistant. You have NO tools — do not try to read or write files, run commands or browse (any tool use is blocked and counts as failure). Answer the LAST user message using only the transcript. Reply in the same language the user writes in. Use Markdown. If a correct answer genuinely requires reading files not shown, running commands or editing files, reply with exactly JEV_NEEDS_TOOLS and nothing else.\n\n";

  const reminderSet = new Set<string>();
  const reminderList: string[] = []; // kept in order of appearance
  const messages: string[] = [];
  
  const extractReminders = (content: string): string => {
    const matches = [...content.matchAll(SYSTEM_REMINDER)];
    for (const match of matches) {
      let inner = match[1] || '';
      if (inner.length > 4000) inner = inner.substring(0, 4000) + '...';
      const rendered = `<system-reminder>${inner}</system-reminder>`;
      if (!reminderSet.has(rendered)) {
        reminderSet.add(rendered);
        reminderList.push(rendered);
      }
    }
    return content.replace(SYSTEM_REMINDER, '').trim();
  };

  for (const m of body.messages) {
    if (m.role === 'system') continue;
    
    let text = `### ${m.role === 'user' ? 'User' : 'Assistant'}\n`;
    if (typeof m.content === 'string') {
      let content = m.content;
      if (m.role === 'user') {
        content = extractReminders(content);
      }
      text += content + '\n\n';
    } else {
      for (const b of m.content) {
        if (b.type === 'text' && typeof b.text === 'string') {
          let content = b.text;
          if (m.role === 'user') {
            content = extractReminders(content);
          }
          text += content + '\n';
        } else if (b.type === 'tool_use') {
          const input = JSON.stringify(b.input || {}).substring(0, 2000);
          text += `[assistant called tool ${(b as any).name} with input: ${input}]\n`;
        } else if (b.type === 'tool_result') {
          const bAny = b as any;
          let content = '';
          if (typeof bAny.content === 'string') {
            content = bAny.content;
          } else if (Array.isArray(bAny.content)) {
            content = bAny.content
              .filter((blk: any) => blk.type === 'text')
              .map((blk: any) => blk.text)
              .join('\n');
          } else {
            content = JSON.stringify(bAny.content || {});
          }
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

  // Cap reminders to 12000 chars total, keeping the most recent ones
  let finalReminders = '';
  if (reminderList.length > 0) {
    let remLen = 0;
    const keptReminders: string[] = [];
    for (let i = reminderList.length - 1; i >= 0; i--) {
      const r = reminderList[i]! + '\n\n';
      if (remLen + r.length > 12000) break;
      remLen += r.length;
      keptReminders.unshift(r);
    }
    if (keptReminders.length > 0) {
      finalReminders = "System reminders:\n" + keptReminders.join('');
    }
  }

  const preamble = preambleText + finalReminders;

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
