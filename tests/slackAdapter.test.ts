import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendMessageOptions, SendAttachment } from '../src/providers/types.js';
import type { TurnOutput } from '../src/core/conversation.js';
import { SlackAdapter, SlackWebApi, slackUploadUrl, type SlackApi } from '../src/adapters/slack.js';
import { ConversationService, MemoryTurnJournal } from '../src/application/conversationService.js';
import { classifyChat, UnsupportedChatFormError } from '../src/common/chatClassification.js';
const event = (id:string,ts:string,thread?:string) => ({team_id:'T',event_id:id,event:{type:'app_mention',user:'U',channel:'C',text:'<@BOT> question',ts,...(thread?{thread_ts:thread}:{})}});
/** A one-to-one direct message needs no mention; only its allowlisted counterpart identifies it. */
const directMessage = (id:string,ts:string,user='U',channel='D',channelType='im',thread?:string) =>
 ({team_id:'T',event_id:id,event:{type:'message',channel_type:channelType,user,channel,text:'question',ts,...(thread?{thread_ts:thread}:{})}});
test('Slack service shutdown cancels active text-engine generation without delivering', { timeout: 2000 }, async () => {
 const f=setup(); let began!:()=>void;
 const started=new Promise<void>(resolve=>{began=resolve});
 let signal:AbortSignal|undefined;
 f.engine.sendMessage=async(_key,_prompt,_files,options)=>{
  signal=options?.signal; assert.ok(signal);
  return new Promise((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});began()});
 };
 try {
  const turn=await f.adapter.receive(event('cancel','1700000003.000000','1700000001.000000'));
  await started; await f.service.shutdown();
  assert.equal(signal!.aborted,true);
  assert.equal((await turn!.completion).state,'cancelled');
  assert.equal(f.posts.length,0);
 } finally { await f.close(); }
});
function setup(maxSessions=1000){
 const dir=mkdtempSync(join(tmpdir(),'slack-adapter-'));const journal=new MemoryTurnJournal();const service=new ConversationService(journal);const prompts:string[]=[],posts:Record<string,string>[]=[];let identity="provider-a/session-1";let reads=0,authorized=true,extra=false,resets=0;let history:Record<string,unknown>[]=[{ts:'1700000001.000000',user:'U',text:'<@BOT> question',thread_ts:'1700000001.000000'},{ts:'1700000002.000000',user:'FRIEND',text:'unmentioned clarification',thread_ts:'1700000001.000000'}];
 let historyUnavailable = false, audienceFailureAt = 0, audienceCalls = 0, channelFlags: Record<string,unknown> = {};
  const sessions:string[]=[],contexts:Array<SendMessageOptions['transportContext']>=[];
  let historyStarted: (() => void) | undefined;
 let audienceStarted: (() => void) | undefined;
 const api: SlackApi={call:async(method:string,args?:Record<string,string>,signal?:AbortSignal)=>{
  if(method==='conversations.members' && audienceStarted) await new Promise<void>((_resolve,reject)=>{assert.ok(signal);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});audienceStarted!();});
  if(method==='conversations.members' && ++audienceCalls === audienceFailureAt) throw new Error('Slack temporarily unavailable');
  if(method==='conversations.info')return {ok:true,channel:{is_member:true,...channelFlags}};
  if(method==='conversations.members')return {ok:true,members:authorized
    ? (channelFlags.is_im ? ['U','BOT'] : ['U','FRIEND','BOT',...(extra?['NEW']:[])])
    : ['FRIEND','BOT']};
  if(method==='chat.postMessage'){posts.push(args!);return {ok:true,ts:'1900000009.000001'}};
  if(method==='conversations.replies'||method==='conversations.history'){
   reads++;
   if(historyStarted) await new Promise<void>((_resolve,reject)=>{signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true});historyStarted!();});
   if(historyUnavailable)throw new Error('missing_scope');return {ok:true,messages:history}
  }
  throw Error(method);
 }};
 const engine={contextIdentity:()=>identity,sendMessage:async(key:string,prompt:string,_files?:SendAttachment[],options?:SendMessageOptions)=>{sessions.push(key);contexts.push(options?.transportContext);prompts.push(prompt);return {content:'answer',attachments:[]}},resetSession:async()=>{resets++},shutdown:async()=>{}};
 const excludedAuthors=new Set<string>();
 const adapter=new SlackAdapter({teamId:'T',installationId:'i',botUserId:'BOT',channels:new Set(['C','D']),users:new Set(['U']),excludedAuthors,stateDirectory:dir},api,api,engine,service,maxSessions);
 return {dir,api,adapter,engine,service,prompts,posts,journal,sessions,contexts,blockAudience:(started:()=>void)=>{audienceStarted=started},blockHistory:(started:()=>void)=>{historyStarted=started},failAudienceCheck:(offset:number)=>{audienceFailureAt=audienceCalls+offset},loseHistoryAccess:()=>{historyUnavailable=true},exclude:(id:string)=>excludedAuthors.add(id),changeIdentity:(value:string)=>{identity=value},setHistory:(messages:Record<string,unknown>[])=>{history=messages},resets:()=>resets,changeAudience:()=>{extra=true},reads:()=>reads,revoke:()=>{authorized=false},describeChannel:(flags:Record<string,unknown>)=>{channelFlags=flags},close:async()=>{await service.shutdown();rmSync(dir,{recursive:true,force:true})}};
}

test('Slack shutdown aborts audience membership retrieval before generation', { timeout: 2000 }, async () => {
 const f=setup();
 try {
  let began!:()=>void;
  const started=new Promise<void>(resolve=>{began=resolve});
  f.blockAudience(began);
  const turn=await f.adapter.receive(event('audience-cancel','1700000003.000000','1700000001.000000'));
  await started;
  await f.service.shutdown();
  assert.equal((await turn!.completion).state,'cancelled');
  assert.equal(f.prompts.length,0);
  assert.equal(f.posts.length,0);
 } finally {await f.close();}
});

test('Slack rebuilds retained discussion when native recovery happens after preparation', async () => {
 const f=setup();
 try {
  const root='1700000001.000000';
  await (await f.adapter.receive(event('before-recovery','1700000003.000000',root)))!.completion;
  f.setHistory([{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);
  const generate=f.engine.sendMessage;
  f.engine.sendMessage=async(key,prompt,files,options)=>{
   assert.doesNotMatch(prompt,/unmentioned clarification/);
   assert.ok(options?.onSessionRecovery);
   const recovered=options.onSessionRecovery();
   assert.match(recovered,/unmentioned clarification/);
   assert.match(recovered,/Current speaker \(host-verified\)/);
   f.changeIdentity('provider-a/recovered');
   return generate(key,recovered,files,options);
  };
  const turn=await f.adapter.receive(event('native-recovery','1700000004.000000',root));
  assert.equal((await turn!.completion).state,'delivered');
  assert.match(f.prompts[1],/unmentioned clarification/);
 } finally {await f.close();}
});
test('Slack explicit thread mention includes unmentioned discussion and replies in thread',async()=>{
 const f=setup();try{const h=await f.adapter.receive(event('e','1700000003.000000','1700000001.000000'));assert.ok(h);assert.equal((await h.completion).state,'delivered');assert.match(f.prompts[0],/unmentioned clarification/);assert.equal(f.posts[0].thread_ts,'1700000001.000000');assert.ok(f.reads()>0);}finally{await f.close()}
});
test('plain reply, DM, other tenant, and bots never execute',async()=>{
 const f=setup();try{
 for(const payload of [{...event('e','1700000003.000000'),team_id:'OTHER'}, {...event('e','1700000003.000000'),event:{type:'message',user:'U',channel:'C',text:'plain reply',ts:'1700000003.000000'}},{...event('e','1700000003.000000'),event:{...(event('e','1700000003.000000').event),channel:'D1'}},{...event('e','1700000003.000000'),event:{...(event('e','1700000003.000000').event),bot_id:'B'}}]) assert.equal(await f.adapter.receive(payload),undefined);
 assert.equal(f.prompts.length,0);assert.equal(f.posts.length,0);
 }finally{await f.close()}
});
test('Slack duplicate events do not execute twice and revoked membership prevents delivery',async()=>{
 const f=setup();try{const payload=event('e','1700000003.000000','1700000001.000000');await (await f.adapter.receive(payload))!.completion;await (await f.adapter.receive(payload))!.completion;assert.equal(f.prompts.length,1);f.revoke();const denied=await f.adapter.receive(event('next','1700000004.000000','1700000001.000000'));assert.equal((await denied!.completion).state,'failed');assert.equal(f.prompts.length,1);assert.equal(f.posts.length,1);}finally{await f.close()}
});
test('recovered generated output cannot cross a changed audience',async()=>{
 const f=setup();try{
 const generate=f.engine.sendMessage;let output:TurnOutput|undefined;
 f.engine.sendMessage=async(...args)=>{const result=await generate(...args);output=result;return result};
 const payload=event('recovery','1700000003.000000','1700000001.000000');const handle=await f.adapter.receive(payload);const delivered=await handle!.completion;
 assert.equal(delivered.state,'delivered');assert.ok(output?.audienceTag);
 f.journal.put({...delivered,state:'generated',output,receipt:undefined});f.changeAudience();
 await f.adapter.recover();assert.equal(f.journal.get(delivered.id)?.state,'failed');
 assert.equal(f.posts.length,1);assert.equal(f.prompts.length,1);
 }finally{await f.close()}
});

test('Slack recovers generated top-level channel output without rerunning the provider', async () => {
 const f=setup();
 try {
  const generate=f.engine.sendMessage;let output:TurnOutput|undefined;
  f.engine.sendMessage=async(...args)=>{const result=await generate(...args);output=result;return result};
  const handle=await f.adapter.receive(event('channel-recovery','1700000003.000000'));
  const delivered=await handle!.completion;
  assert.equal(delivered.input.conversation.kind,'channel');assert.ok(output?.audienceTag);
  f.journal.put({...delivered,state:'generated',output,receipt:undefined});
  await f.adapter.recover();
  assert.equal(f.journal.get(delivered.id)?.state,'delivered');
  assert.equal(f.posts.length,2);assert.equal(f.posts[1].thread_ts,undefined);assert.equal(f.prompts.length,1);
 } finally {await f.close();}
});

for (const check of [1, 2]) test('Slack recovery preserves output when authorization check ' + check + ' is unavailable', async () => {
 const f = setup();
 try {
  const generate = f.engine.sendMessage;
  let output: TurnOutput | undefined;
  f.engine.sendMessage = async (...args) => { const result = await generate(...args); output = result; return result; };
  const handle = await f.adapter.receive(event('retry-recovery', '1700000003.000000', '1700000001.000000'));
  const delivered = await handle!.completion;
  assert.equal(delivered.state, 'delivered');
  assert.ok(output?.audienceTag);
  f.journal.put({ ...delivered, state: 'generated', output, receipt: undefined });
  f.failAudienceCheck(check);
  await f.adapter.recover();
  assert.equal(f.journal.get(delivered.id)?.state, 'generated');
  assert.equal(f.posts.length, 1);
  await f.adapter.recover();
  assert.equal(f.journal.get(delivered.id)?.state, 'delivered');
  assert.equal(f.journal.get(delivered.id)?.output, undefined);
  assert.equal(f.journal.get(delivered.id)?.error, undefined);
  assert.equal(f.posts.length, 2);
  assert.equal(f.prompts.length, 1);
 } finally { await f.close(); }
});

test('Slack resets retained provider history before continuing after history access is lost', async () => {
 const f = setup();
 try {
  const root = '1700000001.000000';
  await (await f.adapter.receive(event('history-first', '1700000003.000000', root)))!.completion;
  assert.match(f.prompts[0], /unmentioned clarification/);
  const resets = f.resets();
  f.loseHistoryAccess();
  const generate = f.engine.sendMessage;
  f.engine.sendMessage = async (...args) => {
   assert.equal(f.resets(), resets + 1, 'old context must be cleared before provider execution');
   return generate(...args);
  };
  const result = await (await f.adapter.receive(event('history-lost', '1700000004.000000', root)))!.completion;
  assert.equal(result.state, 'delivered');
  assert.match(f.prompts[1], /unavailable/);
  assert.doesNotMatch(f.prompts[1], /unmentioned clarification|Previously supplied records retained/);
 } finally { await f.close(); }
});

test('Slack cancellation during history retrieval preserves the existing provider session', { timeout: 2000 }, async () => {
 const f = setup();
 try {
  const root = '1700000001.000000';
  await (await f.adapter.receive(event('history-before-cancel', '1700000003.000000', root)))!.completion;
  const resets = f.resets();
  let began!: () => void;
  const fetching = new Promise<void>(resolve => { began = resolve; });
  f.blockHistory(began);
  const turn = await f.adapter.receive(event('history-cancel', '1700000004.000000', root));
  await fetching;
  await f.service.shutdown();
  assert.equal((await turn!.completion).state, 'cancelled');
  assert.equal(f.resets(), resets);
  assert.equal(f.prompts.length, 1);
 } finally { await f.close(); }
});

test('sampling a long thread does not erase retained context',async()=>{
 const f=setup();try{
 const root='1700000001.000000';const records=Array.from({length:70},(_,i)=>({ts:String(1700000001+i)+'.000000',thread_ts:root,user:'FRIEND',text:'discussion '+i}));
 f.setHistory(records);await (await f.adapter.receive(event('long-1','1700000100.000000',root)))!.completion;
 const resets=f.resets();f.setHistory([...records,{ts:'1700000100.000000',thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000101.000000',thread_ts:root,user:'FRIEND',text:'new detail'}]);
 await (await f.adapter.receive(event('long-2','1700000102.000000',root)))!.completion;
 assert.equal(f.resets(),resets);assert.match(f.prompts[1],/new detail/);
 }finally{await f.close()}
});
test('editing the original bot mention rebuilds the session with the observed revision',async()=>{
 const f=setup();try{
 await (await f.adapter.receive(event('original','1700000001.000000')))!.completion;const resets=f.resets();
 f.setHistory([{ts:'1700000001.000000',thread_ts:'1700000001.000000',user:'U',text:'<@BOT> corrected requirement',edited:{ts:'1700000002.000000'}}]);
 await (await f.adapter.receive(event('edited','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);assert.match(f.prompts[1],/corrected requirement/);
 }finally{await f.close()}
});
test('a confirmed deletion rebuilds context while complete fetched records are separate from selection',async()=>{
 const f=setup();try{
 await (await f.adapter.receive(event('original','1700000001.000000')))!.completion;const resets=f.resets();f.setHistory([]);
 await (await f.adapter.receive(event('deleted','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);
 }finally{await f.close()}
});

for(const identity of ['provider-b/session-1','provider-a/session-2'])test('Slack replays history when context identity becomes '+identity,async()=>{
 const f=setup();try{
 const root='1700000001.000000';
 await (await f.adapter.receive(event('identity-first','1700000003.000000',root)))!.completion;
 const history=[{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}];f.setHistory(history);
 await (await f.adapter.receive(event('identity-same','1700000004.000000',root)))!.completion;
 assert.doesNotMatch(f.prompts[1],/unmentioned clarification/);
 const resets=f.resets();f.setHistory([...history,{ts:'1700000004.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);f.changeIdentity(identity);
 await (await f.adapter.receive(event('identity-changed','1700000005.000000',root)))!.completion;
 assert.equal(f.resets(),resets+1);assert.match(f.prompts[2],/unmentioned clarification/);
 }finally{await f.close()}
});

test('changed author exclusions invalidate earlier channel context outside the thread window',async()=>{
 const f=setup();try{
 f.setHistory([{ts:'1700000000.000000',user:'FRIEND',text:'old channel secret'}]);
 await (await f.adapter.receive(event('policy-first','1700000001.000000')))!.completion;
 assert.match(f.prompts[0],/old channel secret/);const resets=f.resets();
 f.exclude('FRIEND');f.setHistory([{ts:'1700000001.000000',thread_ts:'1700000001.000000',user:'U',text:'<@BOT> question'}]);
 await (await f.adapter.receive(event('policy-changed','1700000003.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);assert.doesNotMatch(f.prompts[1],/old channel secret/);
 f.setHistory(['1700000001.000000','1700000003.000000'].map(ts=>({ts,thread_ts:'1700000001.000000',user:'U',text:'<@BOT> question'})));
 await (await f.adapter.receive(event('policy-stable','1700000004.000000','1700000001.000000')))!.completion;
 assert.equal(f.resets(),resets+1);
 }finally{await f.close()}
});

test('shared Slack prompt includes verified attribution for the current request',async()=>{
 const f=setup();try{await (await f.adapter.receive(event('speaker','1700000003.000000','1700000001.000000')))!.completion;
 assert.match(f.prompts[0],/Current speaker \(host-verified\): {"platform":"slack","tenantId":"T","userId":"U"}/);
 }finally{await f.close()}
});

test('Slack caps new sessions before provider execution while existing sessions keep working', async () => {
 const f=setup(2);
 try {
  for(let n=1;n<=3;n++) {
   const turn=await f.adapter.receive(event('root-'+n,`170000000${n}.000000`,`160000000${n}.000000`));
   assert.equal((await turn!.completion).state,n<=2?'delivered':'failed');
  }
  assert.equal(f.prompts.length,2);
  assert.equal(readdirSync(f.dir).filter(name=>name.endsWith('.json')).length,2);
  const resumed=await f.adapter.receive(event('existing','1700000004.000000','1600000001.000000'));
  assert.equal((await resumed!.completion).state,'delivered');
  assert.equal(f.prompts.length,3);
 } finally {await f.close();}
});

test('Slack compacts context at its metadata budget and resets before reusing provider history', async () => {
 const f=setup();
 try {
  const root='1700000001.000000';
  await (await f.adapter.receive(event('budget-first','1700000003.000000',root)))!.completion;
  const path=join(f.dir,readdirSync(f.dir).find(name=>name.endsWith('.json'))!);
  const state=JSON.parse(readFileSync(path,'utf8')) as {represented:string[];seen:Record<string,string>;positions:Record<string,string>;scopes:Record<string,string>};
  const entries=Object.keys(state.seen).length+Object.keys(state.positions).length+Object.keys(state.scopes).length;
  state.represented=Array.from({length:4000-entries},()=>state.represented[0]);
  writeFileSync(path,JSON.stringify(state));
  f.setHistory([{ts:root,thread_ts:root,user:'U',text:'<@BOT> question'},{ts:'1700000002.000000',thread_ts:root,user:'FRIEND',text:'unmentioned clarification'},{ts:'1700000003.000000',thread_ts:root,user:'U',text:'<@BOT> question'}]);
  const resets=f.resets();
  await (await f.adapter.receive(event('budget-compact','1700000004.000000',root)))!.completion;
  const compacted=JSON.parse(readFileSync(path,'utf8')) as {resetRequired:boolean;represented:string[]};
  assert.equal(compacted.resetRequired,true);
  assert.ok(compacted.represented.length<10);
  assert.equal(f.resets(),resets);
  await (await f.adapter.receive(event('budget-reset','1700000005.000000',root)))!.completion;
  assert.equal(f.resets(),resets+1);
  assert.match(f.prompts[2],/unmentioned clarification/);
 } finally {await f.close();}
});


const uploadSamples = [
 { name: 'pixel.png', mime: 'image/png', kind: 'image', binary: false, data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64') },
 { name: 'notes.md', mime: 'text/markdown', kind: 'file', binary: false, data: Buffer.from('# Notes\nInspect this attachment.') },
 { name: 'report.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'file', binary: true, data: Buffer.from('PK\x03\x04document fixture') },
 { name: 'report.pdf', mime: 'application/pdf', kind: 'file', binary: true, data: Buffer.from('%PDF-1.4\ntransport fixture\n%%EOF') },
 { name: 'sheet.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'file', binary: true, data: Buffer.from('PK\x03\x04spreadsheet fixture') },
 { name: 'rows.csv', mime: 'text/csv', kind: 'file', binary: false, data: Buffer.from('name,value\none,1\n') },
];
function withFiles(files: unknown, thread?: string, text = '<@BOT> inspect these files') {
 const payload=event('upload','1700000003.000000',thread);
 return {...payload,event:{...payload.event,text,subtype:'file_share',files}};
}
function fileMetadata(sample=uploadSamples[0], id='F123') {
 return {id,name:sample.name,mimetype:sample.mime,size:sample.data.length,url_private:'https://files.slack.com/files-pri/T-'+id+'/'+sample.name};
}
for (const thread of [undefined, '1700000001.000000']) for (const sample of uploadSamples) {
 test('Slack ingests '+sample.name+' in '+(thread?'thread reply':'channel mention')+' with text and cleans up', async () => {
  const f=setup();let paths:string[]=[];let downloads=0;let recovered='';
  const previousMode=process.env.DISCORD_ATTACHMENT_MODE;process.env.DISCORD_ATTACHMENT_MODE='text';
  try {
   f.api.downloadFile=async(url,signal)=>{assert.equal(url,fileMetadata(sample).url_private);assert.equal(signal.aborted,false);downloads++;return new Response(sample.data,{headers:{'content-type':sample.mime}})};
   f.engine.sendMessage=async(_key,prompt,files,options)=>{
    assert.match(prompt,/inspect these files/);assert.doesNotMatch(prompt,/files\.slack\.com|Bearer/);
    assert.equal(files?.length,1);const file=files![0];paths.push(file.path);
    assert.equal(file.displayName,sample.name);assert.equal(file.kind,sample.kind);assert.equal(Boolean(file.binary),sample.binary);
    assert.deepEqual(readFileSync(file.path),sample.data);recovered=options!.onSessionRecovery!();assert.match(recovered,/inspect these files/);
    return {content:'inspected',attachments:[]};
   };
   const payload=withFiles([fileMetadata(sample)],thread);
   const result=await (await f.adapter.receive(payload))!.completion;assert.equal(result.state,'delivered');
    assert.equal(f.posts[0].thread_ts,thread);assert.equal(f.posts[0].text,'inspected');
   assert.equal(downloads,1);assert.ok(paths.every(p=>!existsSync(p)));
   await (await f.adapter.receive(payload))!.completion;assert.equal(downloads,1);
   assert.doesNotMatch(JSON.stringify(f.journal.all()),/files\.slack\.com/);
  } finally { if(previousMode===undefined)delete process.env.DISCORD_ATTACHMENT_MODE;else process.env.DISCORD_ATTACHMENT_MODE=previousMode;await f.close(); }
 });
}
test('Slack passes multiple attachments with a mention-only request',async()=>{
 const f=setup();try{
  const samples=uploadSamples.slice(0,3);let count=0;
  f.api.downloadFile=async()=>new Response(samples[count++].data);
  f.engine.sendMessage=async(_key,_prompt,files)=>{assert.equal(files?.length,3);return {content:'inspected all',attachments:[]}};
  assert.equal((await (await f.adapter.receive(withFiles(samples.map((s,i)=>fileMetadata(s,'F'+i)),undefined,'<@BOT>')))!.completion).state,'delivered');
  assert.equal(count,3);
 }finally{await f.close()}
});
test('Slack resolves incomplete event file metadata using bot files.info',async()=>{
 const f=setup();const original=f.api.call;let lookedUp=false;
 try {
  f.api.call=async(method,args,signal)=>{if(method==='files.info'){assert.equal(args?.file,'F123');lookedUp=true;return {ok:true,file:fileMetadata()}}return original(method,args,signal)};
  f.api.downloadFile=async()=>new Response(uploadSamples[0].data);
  f.engine.sendMessage=async(_k,_p,files)=>{assert.equal(files?.length,1);return {content:'ok',attachments:[]}};
  assert.equal((await (await f.adapter.receive(withFiles([{id:'F123'}])))!.completion).state,'delivered');assert.equal(lookedUp,true);
 }finally{await f.close()}
});
for(const thread of [undefined,'1700000001.000000']) test('Slack download failure warns the provider and user in '+(thread?'thread':'channel'),async()=>{
 const f=setup();try{
  f.api.downloadFile=async()=>new Response('denied',{status:403});
  f.engine.sendMessage=async(_key,prompt,files,options)=>{assert.match(prompt,/pixel.png: download failed \(HTTP 403\)/);assert.match(options!.onSessionRecovery!(),/download failed/);assert.equal(files,undefined);return {content:'Could not inspect the file.',attachments:[]}};
  assert.equal((await (await f.adapter.receive(withFiles([fileMetadata()],thread)))!.completion).state,'delivered');assert.match(f.posts[0].text,/pixel.png: download failed/);
 }finally{await f.close()}
});
test('Slack rejects unauthorized uploads before any file I/O',async()=>{
 const f=setup();try{
  f.api.downloadFile=async()=>{throw Error('must not download')};f.revoke();
  assert.equal((await (await f.adapter.receive(withFiles([fileMetadata()])))!.completion).state,'failed');assert.equal(f.prompts.length,0);assert.equal(f.posts.length,0);
 }finally{await f.close()}
});
test('Slack membership loss during a download prevents provider access and cleans up',async()=>{
 const f=setup();try{
  f.api.downloadFile=async()=>{f.revoke();return new Response(uploadSamples[0].data)};
  assert.equal((await (await f.adapter.receive(withFiles([fileMetadata()])))!.completion).state,'failed');assert.equal(f.prompts.length,0);assert.equal(f.posts.length,0);
 }finally{await f.close()}
});
test('Slack cancellation aborts file download without generation or delivery', {timeout:2000},async()=>{
 const f=setup();let began!:()=>void;const started=new Promise<void>(r=>{began=r});let downloadSignal:AbortSignal|undefined;
 try{
  f.api.downloadFile=async(_url,signal)=>{downloadSignal=signal;return new Promise((_r,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});began()})};
  const turn=await f.adapter.receive(withFiles([fileMetadata()]));await started;await f.service.shutdown();
  assert.equal((await turn!.completion).state,'cancelled');assert.equal(downloadSignal!.aborted,true);assert.equal(f.prompts.length,0);assert.equal(f.posts.length,0);
 }finally{await f.close()}
});
test('Slack successful downloads are cleaned after provider failure',async()=>{
 const f=setup();let path='';try{
  f.api.downloadFile=async()=>new Response(uploadSamples[0].data);
  f.engine.sendMessage=async(_k,_p,files)=>{path=files![0].path;assert.ok(existsSync(path));throw Error('provider failed')};
  assert.equal((await (await f.adapter.receive(withFiles([fileMetadata()])))!.completion).state,'failed');assert.ok(path);assert.equal(existsSync(path),false);
 }finally{await f.close()}
});

for (const thread of [undefined, '1700000001.000000']) test('Slack posts text before exact provider bytes and completes all files in '+(thread?'a thread':'a channel'), async()=>{
 const f=setup(); const calls:string[]=[]; const bytes:Buffer[]=[];
 try {
  const original=f.api.call;
  f.api.call=async(method,args,signal)=>{
   calls.push(method);
   if(method==='files.getUploadURLExternal') return {ok:true,file_id:'F'+calls.filter(x=>x===method).length,upload_url:'https://files.slack.com/upload/v1/ticket'};
   if(method==='files.completeUploadExternal') { assert.equal(args?.channel_id,'C');assert.equal(args?.thread_ts,thread);assert.deepEqual(JSON.parse(args!.files),[{id:'F1',title:'résumé?.txt'},{id:'F2',title:'two.bin'}]);return {ok:true,files:[{id:'F1'},{id:'F2'}]}; }
   return original(method,args,signal);
  };
  f.api.uploadFile=async(url,data,signal)=>{calls.push('raw');assert.equal(url,'https://files.slack.com/upload/v1/ticket');assert.equal(signal.aborted,false);bytes.push(data);return new Response(null,{status:200});};
  f.engine.sendMessage=async()=>({content:'text first',attachments:[{displayName:'résumé?.txt',data:Buffer.from([0,255,3])},{displayName:'two.bin',data:Buffer.from([4,5])}]});
  const result=await (await f.adapter.receive(event('out-files','1700000003.000000',thread)))!.completion;
  assert.equal(result.state,'delivered');assert.equal(f.posts[0].text,'text first');assert.equal(f.posts[0].thread_ts,thread);assert.deepEqual(bytes,[Buffer.from([0,255,3]),Buffer.from([4,5])]);
  assert.deepEqual(result.receipt?.messageIds,['1900000009.000001','file:F1','file:F2']);
  assert.deepEqual(calls.filter(call=>call==='chat.postMessage'||call==='raw'||call.startsWith('files.')),['chat.postMessage','files.getUploadURLExternal','files.getUploadURLExternal','raw','raw','files.completeUploadExternal']);
 } finally { await f.close(); }
});

test('Slack attachment-only delivery has no text placeholder and rejects unsafe tickets without retry', async()=>{
 const f=setup(); let generated=0, uploads=0;
 try {
  const original=f.api.call;
  f.api.call=async(method,args,signal)=>method==='files.getUploadURLExternal'?{ok:true,file_id:'F1',upload_url:'https://evil.example/upload/v1/ticket'}:original(method,args,signal);
  f.api.uploadFile=async()=>{uploads++;return new Response();};
  f.engine.sendMessage=async()=>{generated++;return {content:'',attachments:[{displayName:'one.txt',data:Buffer.from('one')}]}};
  const result=await (await f.adapter.receive(event('bad-ticket','1700000003.000000','1700000001.000000')))!.completion;
  assert.equal(result.state,'interrupted');assert.equal(f.posts.length,0);assert.equal(uploads,0);assert.equal(generated,1);assert.ok(result.output);
  await f.adapter.recover();assert.equal(generated,1);assert.equal(uploads,0);
 } finally { await f.close(); }
});

test('Slack signed upload URLs reject unsafe targets and never receive bot authorization', async t => {
 for (const url of ['http://files.slack.com/upload/v1/ticket','https://files.slack.com:444/upload/v1/ticket','https://token@files.slack.com/upload/v1/ticket','https://files.slack.com/files-pri/T-F1/file']) assert.throws(()=>slackUploadUrl(url));
 t.mock.method(globalThis,'fetch',async(url: string|URL|Request,options?:RequestInit)=>{
  assert.equal(String(url),'https://files.slack.com/upload/v1/ticket');assert.equal(options?.method,'POST');const headers=new Headers(options?.headers);assert.equal(headers.get('authorization'),null);assert.equal(headers.get('content-type'),'application/octet-stream');
  assert.equal(options?.redirect,'error');
  assert.deepEqual(Buffer.from(await new Response(options?.body).arrayBuffer()),Buffer.from([0,255,1]));return new Response(null,{status:200});
 });
 const response=await new SlackWebApi('xoxb-secret').uploadFile('https://files.slack.com/upload/v1/ticket',Buffer.from([0,255,1]),new AbortController().signal);
  assert.equal(response.ok,true);
});

test('Slack cancellation aborts an in-flight text delivery and cannot mark it delivered', {timeout:2000}, async()=>{
 const f=setup(); let began!:()=>void; const started=new Promise<void>(resolve=>{began=resolve}); let postSignal:AbortSignal|undefined;
 try {
  const original=f.api.call;
  f.api.call=async(method,args,signal)=>{
   if(method!=='chat.postMessage') return original(method,args,signal);
   postSignal=signal;began();
   return new Promise((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(signal!.reason),{once:true}));
  };
  const turn=await f.adapter.receive(event('cancel-text-delivery','1700000003.000000','1700000001.000000'));
  await started;await f.service.shutdown();
  const result=await turn!.completion;
  assert.equal(postSignal!.aborted,true);assert.equal(result.state,'interrupted');assert.equal(f.posts.length,0);
 } finally { await f.close(); }
});

for (const failure of ['ticket', 'transfer', 'completion', 'rate-limit'] as const) test('Slack retains attachment output after '+failure+' delivery failure without a retry', async()=>{
 const f=setup(); let generated=0, uploads=0, completed=0, tickets=0;
 try {
  const original=f.api.call;
  f.api.call=async(method,args,signal)=>{
   if(method==='files.getUploadURLExternal') {
    if(failure==='ticket') throw Error('ticket unavailable');
    if(failure==='rate-limit') throw Error('Slack rate limited; retry after 1 seconds.');
    return {ok:true,file_id:'F'+ ++tickets,upload_url:'https://files.slack.com/upload/v1/ticket'};
   }
   if(method==='files.completeUploadExternal') { completed++; return failure==='completion'?{ok:true,files:[{id:'F1'},{id:'F1'}]}:{ok:true,files:[{id:'F1'}]}; }
   return original(method,args,signal);
  };
  f.api.uploadFile=async()=>{uploads++;return new Response(null,{status:failure==='transfer'?503:200});};
  f.engine.sendMessage=async()=>{generated++;return {content:'text',attachments:[{displayName:'one.txt',data:Buffer.from('one')}]}};
  const result=await (await f.adapter.receive(event('delivery-'+failure,'1700000003.000000','1700000001.000000')))!.completion;
  assert.equal(result.state,'interrupted');assert.ok(result.output);assert.equal(generated,1);assert.equal(uploads,failure==='ticket'||failure==='rate-limit'?0:1);assert.equal(completed,failure==='completion'?1:0);
  await f.adapter.recover();assert.equal(generated,1);assert.equal(uploads,failure==='ticket'||failure==='rate-limit'?0:1);
 } finally { await f.close(); }
});

test('Slack cancellation during raw upload retains output and does not retry it', {timeout:2000}, async()=>{
 const f=setup(); let generated=0, uploadSignal:AbortSignal|undefined;
 try {
  const original=f.api.call;
  f.api.call=async(method,args,signal)=>method==='files.getUploadURLExternal'?{ok:true,file_id:'F1',upload_url:'https://files.slack.com/upload/v1/ticket'}:original(method,args,signal);
  let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve});
  f.api.uploadFile=async(_url,_data,signal)=>{uploadSignal=signal;began();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
  f.engine.sendMessage=async()=>{generated++;return {content:'',attachments:[{displayName:'one.txt',data:Buffer.from('one')}]}};
  const turn=await f.adapter.receive(event('cancel-upload','1700000003.000000','1700000001.000000'));await started;await f.service.shutdown();
  const result=await turn!.completion;assert.equal(result.state,'interrupted');assert.equal(uploadSignal!.aborted,true);assert.ok(result.output);await f.adapter.recover();assert.equal(generated,1);
 } finally { await f.close(); }
});

test('Slack delivery-time authorization failure starts no attachment upload', async()=>{
 const f=setup(); let uploads=0;
 try {
  f.api.uploadFile=async()=>{uploads++;return new Response();};
  f.engine.sendMessage=async()=>{f.revoke();return {content:'',attachments:[{displayName:'one.txt',data:Buffer.from('one')}]}};
  const result=await (await f.adapter.receive(event('delivery-revoked','1700000003.000000','1700000001.000000')))!.completion;
  assert.equal(result.state,'failed');assert.equal(uploads,0);
 } finally { await f.close(); }
});

for(const form of ['channel','thread'] as const) test('Slack classifies '+form+' conversations before delivering context to the agent',async()=>{
 const f=setup();try{
  const thread=form==='thread'?'1700000001.000000':undefined;
  const result=await (await f.adapter.receive(event('classified-'+form,'1700000003.000000',thread)))!.completion;
  assert.equal(result.state,'delivered');
  assert.deepEqual(f.contexts,[{platform:'slack',history:true,attachments:true,classification:{platform:'slack',form,choice:'direct_reply'}}]);
  assert.equal(f.prompts.length,1);
 }finally{await f.close()}
});

test('Slack admits an allowlisted one-to-one direct message and answers it in that direct message',async()=>{
  const f=setup();try{
   f.describeChannel({is_im:true});
   f.setHistory([{ts:'1700000001.000000',user:'U',text:'earlier question'},{ts:'1700000002.000000',user:'U',text:'unmentioned follow-up'}]);
   const result=await (await f.adapter.receive(directMessage('dm-admitted','1700000003.000000')))!.completion;
   assert.equal(result.state,'delivered');
   assert.match(result.sessionKey,/"individual","U"\]$/);
   assert.equal(result.input.conversation.kind,'direct');
   assert.equal(result.input.conversation.channelId,'D');
   assert.equal(result.input.text,'question');
   assert.deepEqual(f.contexts,[{platform:'slack',history:true,attachments:true,classification:{platform:'slack',form:'direct',choice:'direct_reply'}}]);
   assert.equal(f.prompts.length,1);
   assert.ok(f.prompts[0].includes('earlier question'));
   assert.deepEqual(f.posts.map(p=>[p.channel,p.thread_ts]),[['D',undefined]]);
  }finally{await f.close()}
});

test('Slack direct-message history resolves to the direct conversation and never to a thread',async()=>{
  const f=setup();try{
   f.describeChannel({is_im:true});
   f.setHistory([{ts:'1700000001.000000',user:'U',text:'earlier question'},{ts:'1700000002.000000',user:'U',text:'unmentioned clarification'}]);
   let options:SendMessageOptions|undefined;
   const methods:string[]=[];const original=f.api.call;
   f.api.call=async(method,args,signal)=>{methods.push(method);return original(method,args,signal)};
   f.engine.sendMessage=async(_key,_prompt,_files,opts)=>{options=opts;return {content:'answer',attachments:[]}};
   await (await f.adapter.receive(directMessage('dm-scope','1700000003.000000')))!.completion;
   assert.ok(options?.resolveChannelHistory);
   await assert.rejects(()=>options!.resolveChannelHistory!({scope:'thread',range:'recent',count:5}),/Unsupported history scope/);
   await assert.rejects(()=>options!.resolveChannelHistory!({scope:'nonsense',range:'recent',count:5}),/Unsupported history scope/);
   const summary=await options!.resolveChannelHistory!({scope:'channel',range:'recent',count:5});
   assert.match(summary,/unmentioned clarification/);
   assert.ok(methods.includes('conversations.history'));
   assert.ok(!methods.includes('conversations.replies'));
  }finally{await f.close()}
});

test('Slack keeps an admitted direct message session-isolated from channels and threads',async()=>{
  const f=setup();try{
   f.describeChannel({is_im:true});
   await (await f.adapter.receive(directMessage('iso-direct','1700000005.000000')))!.completion;
   f.describeChannel({});
   await (await f.adapter.receive(event('iso-channel','1700000003.000000')))!.completion;
   await (await f.adapter.receive(event('iso-thread','1700000004.000000','1700000001.000000')))!.completion;
   f.describeChannel({is_im:true});
   await (await f.adapter.receive(directMessage('iso-direct-2','1700000006.000000')))!.completion;
   assert.equal(new Set(f.sessions).size,3);
   assert.deepEqual(f.contexts.map(c=>c?.classification?.form),['direct','channel','thread','direct']);
   assert.equal(f.sessions[0],f.sessions[3]);
   assert.match(f.sessions[0],/"individual","U"\]$/);
   assert.match(f.sessions[1],/"shared",null\]$/);
   assert.match(f.sessions[2],/"shared",null\]$/);
   assert.notEqual(f.sessions[0],f.sessions[1]);
   assert.notEqual(f.sessions[0],f.sessions[2]);
  }finally{await f.close()}
});

test('Slack rejects group DMs, non-allowlisted counterparts and mentions posted to a direct message',async()=>{
  const f=setup();try{
   assert.equal(f.adapter.normalize(directMessage('dm-mpim','1700000003.000000','U','G','mpim')),undefined);
   assert.equal(f.adapter.normalize(directMessage('dm-stranger','1700000003.000000','STRANGER')),undefined);
   assert.equal(f.adapter.normalize(directMessage('dm-channel','1700000003.000000','U','C')),undefined);
   assert.equal(f.adapter.normalize(directMessage('dm-self','1700000003.000000','BOT')),undefined);
   f.describeChannel({is_mpim:true});
   const grouped=await f.adapter.receive(directMessage('dm-group','1700000003.000000'));
   assert.equal((await grouped!.completion).state,'failed');
   assert.equal(f.prompts.length,0);assert.equal(f.contexts.length,0);assert.equal(f.posts.length,0);
  }finally{await f.close()}
});

test('Slack classification keeps channel and thread contexts in separate sessions',async()=>{
 const f=setup();try{
  await (await f.adapter.receive(event('iso-channel','1700000003.000000')))!.completion;
  await (await f.adapter.receive(event('iso-thread','1700000004.000000','1700000001.000000')))!.completion;
  assert.equal(f.sessions.length,2);assert.notEqual(f.sessions[0],f.sessions[1]);
  assert.deepEqual(f.contexts.map(c=>c?.classification?.form),['channel','thread']);
  assert.deepEqual(f.posts.map(p=>p.thread_ts),[undefined,'1700000001.000000']);
 }finally{await f.close()}
});

test('Slack rejects ambiguous conversation forms before the provider runs',async()=>{
 const f=setup();try{
  assert.throws(()=>classifyChat({platform:'slack',kind:'thread'}),UnsupportedChatFormError);
  assert.throws(()=>classifyChat({platform:'slack',kind:'huddle'}),UnsupportedChatFormError);
 }finally{await f.close()}
});

test('Slack skips replayed output whose conversation no longer has a classifiable form',async()=>{
 const f=setup();let output:TurnOutput|undefined;
 try{
  const generate=f.engine.sendMessage;f.engine.sendMessage=async(...args)=>{const result=await generate(...args);output=result;return result};
  const handle=await f.adapter.receive(event('ambiguous-replay','1700000003.000000','1700000001.000000'));
  const delivered=await handle!.completion;
  assert.equal(delivered.state,'delivered');assert.ok(output?.audienceTag);
  const ambiguous={...delivered,state:'generated' as const,output,receipt:undefined,
   input:{...delivered.input,conversation:{...delivered.input.conversation,threadId:undefined}}};
  f.journal.put(ambiguous);
  const logged:string[]=[];const original=console.error;console.error=(...args:unknown[])=>{logged.push(args.map(String).join(' '))};
  try{await f.adapter.recover();}finally{console.error=original;}
  assert.match(logged.join('\n'),/Unsupported conversation form: Thread chat form requires its thread identity/);
  assert.equal(f.journal.get(ambiguous.id)?.state,'generated');
  assert.equal(f.posts.length,1);assert.equal(f.prompts.length,1);
 }finally{await f.close()}
});
