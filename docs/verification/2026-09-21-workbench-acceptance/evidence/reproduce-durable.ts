import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDriverTerminal } from '../../../../cli/src/auto/driver-terminal.ts';
import { cliRunsRoutes } from '../../../../runtime-host/routes/cli-runs.ts';
import { readCliRun } from '../../../../shared/runtime/cli-runs-index.ts';
import { liveStateFromRecords } from '../../../../shared/runtime/cli-run-progress.ts';
const home = mkdtempSync(join(tmpdir(),'ck-durable-accept-'));
process.env.COUNCILKIT_HOME = home;
const runId='ck-review-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const dir=join(home,'runs',runId); mkdirSync(dir,{recursive:true});
const started={kind:'review.started',version:1,runId,startedAt:new Date().toISOString(),task:{task:'acceptance-fixture'},attempts:[{attemptId:'attempt-0',agentName:'A',agentId:'a',driverId:'grok-stream-json',modelId:'m'},{attemptId:'attempt-1',agentName:'B',agentId:'b',driverId:'grok-stream-json',modelId:'m'}],aggregator:{attemptId:'aggregator',agentName:'B',agentId:'b',driverId:'grok-stream-json',modelId:'m'}};
function finished(id:string,status='success',extra:any={}){return {kind:'attempt.finished',version:1,attemptId:id,agentName:'A',driverId:'grok-stream-json',status,output:status==='success'?'current report':null,exitCode:status==='success'?0:1,durationMs:100,attemptNumber:1,...extra};}
const route=cliRunsRoutes().find(r=>r.pattern.endsWith('/attempts/:attemptId/result'))!;
async function inspect(label:string,records:any[],id='attempt-0'){
 writeFileSync(join(dir,'transcript.jsonl'),records.map(r=>JSON.stringify(r)).join('\n')+'\n');
 const live=liveStateFromRecords(records,new Date().toISOString());
 if(live)writeFileSync(join(dir,'status.json'),JSON.stringify(live));
 const result:any=await route.handler({params:{runId,attemptId:id}} as any);
 const detail=readCliRun(runId,process.env);
 console.log(JSON.stringify({label,detailStatus:detail?.status,seatStatus:detail?.progress?.attempts.find(s=>s.attemptId===id)?.status,result:{...result,markdown:result.markdown===null?null:result.markdown.length}}));
 return result;
}
async function main(){
 await inspect('full-report-300KiB',[started,finished('attempt-0','success',{output:'x'.repeat(300*1024)})]);
 await inspect('retry-final',[started,finished('attempt-0','failure',{failure:{code:'EXIT',message:'boom'}}),finished('attempt-0','success',{attemptNumber:2,retryOf:1,output:'new retry'})]);
 await inspect('resume-reuse',[started,finished('attempt-0'),{kind:'review.resumed',version:1,runId,reusedAttemptIds:['attempt-0'],rerunAttemptIds:['attempt-1']}]);
 await inspect('resume-no-old-fallback',[started,finished('attempt-0'),{kind:'review.resumed',version:1,runId,reusedAttemptIds:[],rerunAttemptIds:['attempt-0']}]);
 await inspect('non-retried-auth-exit-other-seat-active',[started,finished('attempt-0','failure',{failure:{code:'EXIT',message:'authentication failed'},durationMs:3000})]);
 console.log(JSON.stringify({label:'auth-classification',terminal:classifyDriverTerminal({stdout:'',stderr:'authentication failed',exitCode:1})}));
 await inspect('same-auth-exit-after-run-finished',[started,finished('attempt-0','failure',{failure:{code:'EXIT',message:'authentication failed'},durationMs:3000}),{kind:'review.finished',version:1,status:'failed',endedAt:new Date().toISOString()}]);
 await inspect('success-output-missing',[started,finished('attempt-0','success',{output:undefined})]);
 console.log(JSON.stringify({fixtureHome:home}));
}
main().catch(error=>{console.error(error);process.exitCode=1;});
