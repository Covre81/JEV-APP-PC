import { isFreshConversation, latestHumanText, type MessagesBody } from './messages-body.js';

export const READ_FIRST_HINT = 'Before answering: if the user asks what to do next, where things stand, or refers to the state of this project (plans, status, progress, pending work), first read the relevant project files with the tools you have (for example README, CLAUDE.md, docs/, plans, handoff notes) and base your answer on them. Do not ask the user to read files you can read yourself.';

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
  
  const text = humanText.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);

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
    if (text.includes(p)) return true;
  }
  
  return false;
}

export function withReadFirstHint(body: MessagesBody): MessagesBody {
  const newBody = { ...body };
  if (!newBody.system) {
    newBody.system = READ_FIRST_HINT;
  } else if (typeof newBody.system === 'string') {
    newBody.system = newBody.system + '\n\n' + READ_FIRST_HINT;
  } else if (Array.isArray(newBody.system)) {
    newBody.system = [...newBody.system, { type: 'text', text: READ_FIRST_HINT }];
  }
  return newBody;
}
