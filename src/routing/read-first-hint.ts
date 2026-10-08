import { hasToolResult, humanTextOf, isFreshConversation, latestHumanText, turns, type MessagesBody } from './messages-body.js';

export const READ_FIRST_HINT = 'The user is asking about the state of this project or what to do next. Before you reply, use your file tools yourself: first list the project files (Glob or LS), then Read the most relevant ones (README, CLAUDE.md, docs/, plan, status, roadmap or handoff files). Base your answer only on what those files say. Do not tell the user to open or read any file; read it yourself. Do not invent people, names, tasks or dates that are not in the files.';

export function matchesReadFirstText(text: string): boolean {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);

  const singleWordPatterns = [
    'status', 'progress', 'roadmap', 'plan', 'pending', 'todo', 
    'andamento', 'pendente', 'plano'
  ];
  for (const p of singleWordPatterns) {
    if (tokens.includes(p)) return true;
  }

  const multiWordPatterns = [
    'what next', 'next step', 'what should i do', 'what should we do', 'what can we do',
    'where were we', 'what is left', 'o que fazer', 'o que falta', 'proximo passo', 
    'proximos passos', 'onde paramos', 'estou pensando', 'o que podemos fazer', 
    'por onde comecar'
  ];
  for (const p of multiWordPatterns) {
    if (normalized.includes(p)) return true;
  }
  
  return false;
}

export function needsReadFirstHint(body: MessagesBody): boolean {
  if (!isFreshConversation(body)) return false;
  const humanText = latestHumanText(body);
  if (humanText === undefined) return false;
  
  if (!body.tools || !Array.isArray(body.tools)) return false;
  const hasTool = body.tools.some(t => {
    const name = typeof t === 'string' ? t : (t && typeof t === 'object' && 'name' in t) ? (t as any).name : '';
    return name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS' || name === 'Bash';
  });
  if (!hasTool) return false;
  
  return matchesReadFirstText(humanText);
}

export function withReadFirstHint(body: MessagesBody, hint = READ_FIRST_HINT): MessagesBody {
  const messages = body.messages || [];
  if (messages.length === 0) return body;
  
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') return body;

  const newBody = { ...body };
  newBody.messages = [...messages];
  
  const reminderBlock = { type: 'text', text: '<system-reminder>\n' + hint + '\n</system-reminder>' };
  const newMessage = { ...lastMessage } as NonNullable<MessagesBody['messages'][number]>;
  
  if (typeof newMessage.content === 'string') {
    newMessage.content = [{ type: 'text', text: newMessage.content }, reminderBlock];
  } else if (Array.isArray(newMessage.content)) {
    newMessage.content = [...newMessage.content, reminderBlock];
  } else {
    newMessage.content = [reminderBlock];
  }
  
  newBody.messages[messages.length - 1] = newMessage;
  return newBody;
}

export const READ_FIRST_FOLLOWUP = 'You have not read the project files yet. Before you answer the user, Read the files that hold the plan or status (for example the plan, status, roadmap, README or CLAUDE.md files you just found), using their paths, and base your answer only on what they say. Do not tell the user to open or read any file; read it yourself. Do not invent people, names, tasks or dates.';

export function needsReadFirstFollowup(body: MessagesBody): boolean {
  if (!body.tools || !Array.isArray(body.tools)) return false;
  const hasReadTool = body.tools.some(t => {
    const name = typeof t === 'string' ? t : (t && typeof t === 'object' && 'name' in t) ? (t as any).name : '';
    return name === 'Read' || name === 'Glob' || name === 'Grep' || name === 'LS' || name === 'Bash';
  });
  if (!hasReadTool) return false;

  const bodyTurns = turns(body);
  if (bodyTurns.length === 0) return false;
  const lastMsg = bodyTurns[bodyTurns.length - 1];
  if (!lastMsg || lastMsg.role !== 'user' || !hasToolResult(lastMsg)) return false;

  let humanTextMessages = 0;
  let firstHumanTextMessageText = '';
  let firstHumanTextMessageIsFirstMessage = false;

  const userMessages = bodyTurns.filter(m => m.role === 'user');
  for (const m of userMessages) {
    if (hasToolResult(m)) continue;
    const text = humanTextOf(m);
    if (text !== undefined) {
      humanTextMessages++;
      if (humanTextMessages === 1) {
        firstHumanTextMessageText = text;
        firstHumanTextMessageIsFirstMessage = m === bodyTurns[0];
      }
    }
  }

  if (humanTextMessages !== 1 || !firstHumanTextMessageIsFirstMessage) return false;
  if (!matchesReadFirstText(firstHumanTextMessageText)) return false;

  const assistantMessages = bodyTurns.filter(m => m.role === 'assistant');
  if (assistantMessages.length > 6) return false;

  for (const m of assistantMessages) {
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          const name = (b as any).name;
          if (name === 'Read') return false;
          if (name === 'Bash') {
            const cmd = (b as any).input?.command;
            if (typeof cmd === 'string' && /\b(cat|type|get-content|head|tail|more|less)\b/i.test(cmd)) {
              return false;
            }
          }
        }
      }
    }
  }

  return true;
}
