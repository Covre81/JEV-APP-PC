import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function ensureAgyHome(home: string): Promise<void> {
  const dir = join(home, '.gemini', 'antigravity-cli');
  await mkdir(dir, { recursive: true });
  
  const settings = {
    allowNonWorkspaceAccess: false,
    toolPermission: "strict",
    enableTerminalSandbox: "on",
    permissions: {
      deny: ["write_file(*)", "read_file(*)", "command(*)", "read_url(*)", "execute_url(*)", "mcp(*)"]
    }
  };
  
  await writeFile(join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
}
