import { createHash, randomUUID } from 'node:crypto';
import { domainError } from './contracts.js';
import { redact } from '../core/cortex-utils.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sampleFields=['tag','fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor','padding','borderRadius'];
export function migrateProfile(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw domainError('PolicyDenied','Profilo non valido.');
  if(input.schemaVersion===undefined||input.schemaVersion===0)input={...input,schemaVersion:1,status:'draft',approval:null};
  if(input.schemaVersion!==1||!Array.isArray(input.samples)||input.samples.length>100||!Array.isArray(input.evidence)||input.evidence.length>20)
    throw domainError('UnsupportedCapability','Schema profilo non supportato.');
  // Approval is never accepted from imported/model-authored content.
  return {schemaVersion:1,profileId:randomUUID(),status:'draft',approval:null,
    samples:input.samples.map(sample=>{if(!sample||typeof sample!=='object'||Array.isArray(sample)||Object.keys(sample).some(k=>!sampleFields.includes(k)))throw domainError('PolicyDenied','Campi campione profilo non ammessi.');return Object.fromEntries(Object.entries(sample).map(([k,v])=>[k,redact(String(v).slice(0,256))]));}),
    evidence:input.evidence.map(e=>({snapshotId:String(e.snapshotId??'').slice(0,128),pageId:String(e.pageId??'').slice(0,128),documentEpoch:Number.isInteger(e.documentEpoch)?e.documentEpoch:null})),
    dependencies:Array.isArray(input.dependencies)?input.dependencies.slice(0,20).map(value=>String(value).slice(0,128)):[],coverage:{complete:false,reason:'imported-unverified'},classification:'observed-convention'};
}
export function design({args,snapshots,profiles,features}) {
  if(args.action==='build') {
    if(!args.snapshotIds?.length)throw domainError('PolicyDenied','build richiede snapshotIds osservati nella sessione.');
    const observations=args.snapshotIds.map(id=>snapshots.get(id));
    const samples=observations.flatMap(o=>o.designSample??[]).slice(0,100),dependencies=observations.map(o=>hash(o.sources??[]));
    const profile={schemaVersion:1,profileId:randomUUID(),status:'draft',classification:'observed-convention',samples,
      evidence:observations.map(o=>({snapshotId:o.snapshotId,...o.target})),dependencies,
      coverage:{complete:false,pages:new Set(observations.map(o=>o.target.pageId)).size,viewports:observations.map(o=>o.state.viewport),missingStates:['hover','focus','invalid','loading','disabled','selected'],
        limitations:['not-aesthetic-or-usability-certification','inline-and-asset-content-hashes-not-collected']},approval:null};
    const approval=features.approvedDesign;
    if(approval?.samplesHash===hash(samples)&&typeof approval.approver==='string'&&typeof approval.version==='string'){
      profile.status='approved';profile.approval={approver:approval.approver.slice(0,128),version:approval.version.slice(0,128),provenance:'host-policy',samplesHash:approval.samplesHash};
    }
    profiles.put(profile,profile.profileId);return profile;
  }
  if(args.action==='import') {
    let input;try{input=JSON.parse(args.profileJson);}catch{throw domainError('PolicyDenied','JSON profilo non valido.');}
    const profile=migrateProfile(input);profiles.put(profile,profile.profileId);return profile;
  }
  const profile=profiles.get(args.profileId,'StaleObservation');
  if(args.action==='get')return profile;
  if(args.action==='export')return {schemaVersion:1,profileJson:JSON.stringify(profile),persistence:'host-managed-opt-in',sha256:hash(profile)};
  if(!args.snapshotIds?.length)throw domainError('PolicyDenied','compare richiede snapshotIds correnti.');
  const observations=args.snapshotIds.map(id=>snapshots.get(id)),current=observations.flatMap(o=>o.designSample??[]).slice(0,100);
  const changes=[];
  for(let i=0;i<Math.max(profile.samples.length,current.length);i++)if(JSON.stringify(profile.samples[i])!==JSON.stringify(current[i]))changes.push({sample:i,expected:profile.samples[i]??null,observed:current[i]??null});
  const dependencies=observations.map(o=>hash(o.sources??[]));
  const stale=JSON.stringify(dependencies)!==JSON.stringify(profile.dependencies);
  if(stale&&profile.status==='approved') {
    profile.status='draft';profile.approval=null;profiles.put(profile,profile.profileId);
  }
  return {profileId:profile.profileId,status:profile.status,comparison:'ordered-observed-samples',changes,
    stale:stale?true:'unknown-without-content-hashes',approvedReference:profile.status==='approved',
    verdict:profile.status==='approved'&&!stale&&changes.length===0?'consistent-with-sampled-approved-values':'review-required',aestheticVerdict:'not-provided'};
}
