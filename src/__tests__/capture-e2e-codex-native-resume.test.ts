import { afterEach, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
let home = '';
let server: http.Server | undefined;
afterEach(async () => {
  if (home) {
    const dir = path.join(home, '.origin', 'heartbeats');
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.pid'))) {
      try { process.kill(Number(fs.readFileSync(path.join(dir, f), 'utf8')), 'SIGTERM'); } catch { /* exited */ }
    }
  }
  server?.closeAllConnections();
  if (server) await new Promise<void>(r => server!.close(() => r()));
  // A detached child of the hook can still be writing under HOME; cleanup is best effort.
  if (home) try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* best effort */ }
});

it.each(['user-prompt-submit', 'stop'])('native %s resumes its archived chat without touching the active sibling', async (event) => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-resume-')));
  const repo = path.join(home, 'repo'); fs.mkdirSync(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git(['init', '-q']); fs.writeFileSync(path.join(repo, 'a.txt'), 'baseline\n'); git(['add', '.']);
  git(['-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-qm','base']);
  const origin = path.join(home, '.origin'); fs.mkdirSync(path.join(origin, 'sessions'), { recursive: true });
  const hits: Array<{url:string;body:any}> = [];
  server = http.createServer((req,res) => { let raw=''; req.on('data',c=>{raw+=c;});req.on('end',()=>{
    hits.push({url:req.url || '',body:raw?JSON.parse(raw):{}});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,models:{},sessionId:'unexpected-new-session'}));
  }); });
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));
  const apiUrl=`http://127.0.0.1:${(server.address() as any).port}`;
  fs.writeFileSync(path.join(origin,'config.json'),JSON.stringify({apiUrl,apiKey:'org_sk_test_resume',orgId:'test',keyType:'team',accountType:'developer'}));
  const native='native-conversation-original'; const originalId='11111111-1111-4111-8111-111111111111';
  const original={sessionId:originalId,sessionTag:'original',agentSessionId:native,claudeSessionId:'',agentSlug:'codex',model:'gpt-6-astra',repoPath:repo,canonicalRepoPath:repo,lastCwd:repo,
    branch:git(['branch','--show-current']),startedAt:new Date(Date.now()-3*86400000).toISOString(),status:'ENDED',endedAt:new Date().toISOString(),prompts:['original prompt'],promptTurnIds:['t-original'],headShaAtStart:git(['rev-parse','HEAD']),headShaAtLastStop:git(['rev-parse','HEAD']),prePromptSha:git(['rev-parse','HEAD'])};
  fs.writeFileSync(path.join(origin,'sessions','original.json'),JSON.stringify(original));
  const siblingFile=path.join(repo,'.git','origin-session-sibling.json');
  fs.writeFileSync(siblingFile,JSON.stringify({...original,sessionId:'22222222-2222-4222-8222-222222222222',sessionTag:'sibling',agentSessionId:'different-native',status:'RUNNING',endedAt:undefined,startedAt:new Date().toISOString(),prompts:['sibling prompt']}));
  const siblingBefore=fs.readFileSync(siblingFile,'utf8');
  const transcript=path.join(home,'rollout.jsonl');
  fs.writeFileSync(transcript,[{type:'session_meta',payload:{id:native,cwd:repo}},...['original prompt','resumed prompt'].map(text=>({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}}))].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const child=spawn(process.execPath,[bin,'hooks','codex',event],{cwd:repo,env:{...process.env,HOME:home,USERPROFILE:home,ORIGIN_WRITE_JOURNAL:'0'},stdio:['pipe','pipe','pipe']});
  let err='';child.stderr.on('data',c=>{err+=c;});child.stdout.resume();
  child.stdin.end(JSON.stringify({session_id:native,turn_id:'resumed-turn',cwd:repo,transcript_path:transcript,prompt:'resumed prompt',model:'gpt-6-astra'}));
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  expect(code,err).toBe(0);
  const state=JSON.parse(fs.readFileSync(path.join(repo,'.git','origin-session-original.json'),'utf8'));
  expect(state.sessionId).toBe(originalId);expect(state.status).toBe('RUNNING');expect(state.endedAt).toBeUndefined();
  expect(state.prompts?.[0]).toBe('original prompt');
  if (event === 'user-prompt-submit') expect(state.prompts).toEqual(['original prompt','resumed prompt']);
  expect(fs.readFileSync(siblingFile,'utf8')).toBe(siblingBefore);
  expect(hits.some(h=>h.url.includes('/session/start'))).toBe(false);
  expect(hits.some(h=>h.url.includes('22222222-2222-4222-8222-222222222222'))).toBe(false);
  expect(hits.some(h => h.url.includes(originalId)), JSON.stringify(hits.map(h => ({ url: h.url, status: h.body.status })))).toBe(true);
  if (event === 'user-prompt-submit') expect(hits.some(h => h.body.status === 'RUNNING')).toBe(true);
},60_000);
