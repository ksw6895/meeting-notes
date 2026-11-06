import { createContext, useContext, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, post, put, remove } from './api.ts';
import { bufferedAudioMs, InputPreview, LectureRecorder, type CaptureOptions } from './recorder.ts';
import type { LectureDetail, LiveNote, NoteItem, Settings, TranscriptSegment } from './types.ts';
import { nearestSegmentId, parseSourceTarget, sourceAnchorId, timestampToMs } from './navigation.ts';

const SourceNavigation = createContext<(value:string)=>void>(()=>{});
function NoteLink({href,children}: {href?:string;children?:ReactNode}) {
 const source=useContext(SourceNavigation);
 return <a href={href} onClick={e=>{if(href?.includes('#source-')){e.preventDefault();source(href);}}}>{children}</a>;
}
const markdownComponents = {a:NoteLink};


type Mode = 'room' | 'online';
type Meeting = LectureDetail & { kind: string; captureMode: Mode; noteStatus: string; noteError: string; noteJobs: Job[]; liveRecorder?: boolean };
type Job = {kind: string;state: string;attempts: number;retryAt: string;error: string;updatedAt: string};
type Live = {partial: string;captions: string[];status: string;message: string};
const time = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600) ? String(Math.floor(s / 3600)).padStart(2,'0') + ':' : ''}${String(Math.floor(s % 3600 / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`; };
const date = (value: string) => new Intl.DateTimeFormat('ko-KR',{month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const statusLabel: Record<string,string> = {draft:'준비',recording:'녹음 중',paused:'일시정지',processing:'정리 중',complete:'완료'};
const modeLabel: Record<Mode,string> = {room:'회의실 · 마이크',online:'온라인 회의 · 마이크 + 화면 소리'};
const modeHint: Record<Mode,string> = {room:'한 공간에 모여서 하는 회의. 노트북 마이크나 회의용 마이크 하나로 모두의 목소리를 받습니다.',online:'Google Meet·Zoom·Discord 등. 녹음을 시작할 때 회의 탭이나 화면을 공유하고 “오디오 공유”를 켜면 상대방 소리도 함께 기록합니다.'};
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
function Icon({name,size=20}: {name: string;size?: number}) {
 const paths: Record<string,ReactNode> = {
  mic:<><rect x="8" y="2" width="8" height="13" rx="4"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></>,
  note:<><path d="M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/><path d="M14 2v7h7M7 13h10M7 17h7"/></>,
  plus:<path d="M12 5v14M5 12h14"/>, search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  settings:<><path d="m9 3-1 3-3 1v4l-2 1 2 2v3l3 1 1 3h5l1-3 3-1v-3l3-2-3-1V7l-3-1-1-3Z"/><circle cx="11.5" cy="12" r="3"/></>,
  arrow:<path d="M4 12h16m-6-6 6 6-6 6"/>, download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  copy:<><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/></>, check:<path d="m4 12 5 5L20 6"/>,
  close:<path d="m6 6 12 12M6 18 18 6"/>, pause:<><path d="M8 5v14M16 5v14" strokeWidth="4"/></>,
  play:<path d="m8 4 12 8-12 8Z"/>, stop:<rect x="6" y="6" width="12" height="12" rx="2"/>,
  sound:<><path d="m3 9 5 0 5-5v16l-5-5H3ZM17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></>,
  star:<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.7l6.2-.9Z"/>,
  bolt:<path d="m13 2-9 12h7l-1 8 10-12h-7Z"/>,
  help:<><circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17h.01"/></>,
  headset:<><path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="2" y="12" width="5" height="8" rx="2"/><rect x="17" y="12" width="5" height="8" rx="2"/></>,
  home:<><path d="m3 10 9-7 9 7v11H3Z"/><path d="M9 21v-8h6v8"/></>,
  refresh:<><path d="M20 7v5h-5M4 17v-5h5"/><path d="M19 10a7 7 0 0 0-12-5l-3 3m1 6a7 7 0 0 0 12 5l3-3"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>
 };
 return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.note}</svg>;
}
function Modal({title,children,onClose}: {title:string;children:ReactNode;onClose:()=>void}) {
 const panel=useRef<HTMLDivElement>(null);
 useEffect(()=> {
  const previous=document.activeElement as HTMLElement;
  const focusable=()=>Array.from(panel.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href]') || []).filter(e=>!(e as HTMLButtonElement).disabled);
  focusable()[0]?.focus();
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape') onClose(); if(e.key==='Tab'){const elements=focusable(),first=elements[0],last=elements.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};
  document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previous?.focus();};
 },[onClose]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget) onClose();}}><div className="modal" ref={panel} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><Icon name="close"/></button></header>{children}</div></div>;
}
function SourceItems({items,onSource}: {items:NoteItem[];onSource:(value:string)=>void}) {
 return <ul className="note-points">{items.map((item,i)=><li key={i}>{item.text}<span className="sources">{item.timestamps.map((t,j)=><button key={j} onClick={()=>onSource(t)}>{t.split('@').at(-1)?.split('–')[0] || '원문'}</button>)}</span></li>)}</ul>;
}
function LiveDocument({note,onSource}: {note:LiveNote;onSource:(value:string)=>void}) {
 return <div className="note-document"><div className="document-eyebrow"><span className="live-dot"/> LIVE NOTES</div><h2>{note.title || '회의의 흐름을 정리하고 있어요'}</h2>{(note.summary||note.overview)&&<p className="summary-text">{note.summary||note.overview}</p>}{Boolean(note.keyMessages?.length)&&<section><h3>결정 사항</h3><SourceItems items={note.keyMessages!} onSource={onSource}/></section>}{(note.sections || []).map((section,i)=><section key={i}><h3>{section.heading}</h3>{section.summary&&<p>{section.summary}</p>}<SourceItems items={section.points} onSource={onSource}/>{section.tables.map((table,j)=><div className="table-wrap" key={j}>{table.title&&<h4>{table.title}</h4>}<table><thead><tr>{table.headers.map((h,k)=><th key={k}>{h}</th>)}<th>근거</th></tr></thead><tbody>{table.rows.map((row,k)=><tr key={k}>{row.cells.map((cell,l)=><td key={l}>{cell}</td>)}<td>{row.timestamps.map((t,l)=><button className="source-button" key={l} onClick={()=>onSource(t)}>{t.split('@').at(-1)?.split('–')[0]}</button>)}</td></tr>)}</tbody></table></div>)}</section>)}{Boolean(note.uncertainties?.length)&&<section className="uncertainties"><h3>확인할 내용</h3><SourceItems items={note.uncertainties!} onSource={onSource}/></section>}{!note.sections?.length&&!note.keyMessages?.length&&<SourceItems items={note.keyPoints||note.topics||[]} onSource={onSource}/>}</div>;
}
function Segment({segment,lectureId,onSaved,onSeek,highlight}: {segment:TranscriptSegment;lectureId:string;onSaved:()=>void;onSeek:(ms:number)=>void;highlight:boolean}) {
 const [editing,setEditing]=useState(false),[text,setText]=useState(''),[saving,setSaving]=useState(false),[error,setError]=useState('');
 return <article className={`segment ${highlight?'highlight':''}`} id={sourceAnchorId(lectureId,segment.id)}><div className="segment-meta"><button className="timestamp" onClick={()=>onSeek(segment.startMs)}>{time(segment.startMs)}</button><span>{segment.overrideText?'교정됨':'받아쓰기'}</span>{!editing&&<button className="text-button edit-button" onClick={()=>{setText(segment.overrideText||segment.rawText);setEditing(true);}}>교정</button>}</div>{editing?<form onSubmit={async e=>{e.preventDefault();setSaving(true);try{await put(`/api/segments/${segment.id}/override`,{text});setEditing(false);onSaved();}catch(e){setError((e as Error).message);}finally{setSaving(false);}}}><textarea aria-label="전사 교정" value={text} onChange={e=>setText(e.target.value)} rows={4}/>{error&&<p role="alert">{error}</p>}<div className="button-row"><button disabled={saving} className="primary small">저장</button><button type="button" onClick={()=>setEditing(false)}>취소</button></div></form>:<p>{segment.overrideText||segment.rawText||<span className="muted">이 구간에서 발언이 감지되지 않았습니다.</span>}</p>}</article>;
}
function Meter({label,level,heard,active,icon}: {label:string;level:number;heard:boolean;active:boolean;icon:string}) {
 return <div className="input-meter"><div className="meter-icon"><Icon name={icon}/></div><div className="meter-info"><div><strong>{label}</strong><span>{!active?'연결 전':level>0.001?'소리 들어오는 중':heard?'입력 확인됨':'소리를 기다리는 중'}</span></div><div className="meter-track" role="meter" aria-label={`${label} 음량`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1,level*5)*100)}><i style={{width:`${Math.min(100,Math.sqrt(level)*170)}%`}}/></div></div>{heard&&active&&<span className="input-check"><Icon name="check" size={16}/></span>}</div>;
}

function NewMeeting({onCreate,busy,error}: {onCreate:(body:object)=>void;busy:boolean;error:string}) {
 const defaultTitle=`${new Date().toLocaleDateString('ko-KR',{month:'long',day:'numeric'})} 회의`;
 return <form onSubmit={e=>{e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));onCreate(data);}} className="form-stack"><p className="muted">이름만 정하면 준비가 끝납니다. 나머지는 비워두어도 괜찮아요.</p><label>회의 이름<input name="title" defaultValue={defaultTitle} required maxLength={300} autoFocus/></label><label>회의 방식<select name="captureMode" defaultValue="room">{(['room','online'] as Mode[]).map(m=><option key={m} value={m}>{modeLabel[m]}</option>)}</select></label><label>참가자 <span className="optional">선택</span><input name="participants" placeholder="예: 성우, 지민, 도윤, 하린"/></label><details><summary>안건과 자주 나올 용어 추가</summary><label>오늘의 안건<textarea name="topic" placeholder="무엇을 논의하는 회의인가요?" rows={3}/></label><label>자주 나올 이름·전문용어<input name="glossary" placeholder="쉼표로 구분해 주세요. 받아쓰기 정확도가 올라갑니다."/></label></details>{error&&<div className="inline-error" role="alert">{error}</div>}<button className="primary full" disabled={busy}>{busy?'준비 중…':'회의 준비하기'}<Icon name="arrow" size={18}/></button></form>;
}
function SettingsForm({settings,onSaved}: {settings:Settings|null;onSaved:()=>void}) {
 const [busy,setBusy]=useState(false),[result,setResult]=useState(''),[error,setError]=useState('');
 if(!settings) return <p>설정을 불러오는 중입니다.</p>;
 const models=settings.noteModels||[];
 async function save(e:FormEvent<HTMLFormElement>) {
  e.preventDefault();setBusy(true);setError('');setResult('');
  const form=e.currentTarget,values=Object.fromEntries(new FormData(form));
  try {
   await put('/api/settings',{...values,realtimeSttEnabled:values.realtimeSttEnabled==='on'});
   for(const input of form.querySelectorAll<HTMLInputElement>('input[type=password]'))input.value='';
   const r=await post<{results:Record<string,{message:string;status:string}>}>('/api/settings/validate');
   const check=r.results.openai;
   if(check.status==='valid')setResult(`저장했습니다. ${check.message}`);else setError(check.message);
   onSaved();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 const keyLabel=settings.openAiKeySource==='env'?'환경 변수(.env)에서 사용 중':settings.openAiKeyStatus==='invalid'?'인증 실패 · 새 키를 입력하세요':settings.openAiKeyPresent?'저장됨 · 새 키를 넣으면 교체':'미등록';
 return <form onSubmit={save} className="form-stack">
  <label>OpenAI API 키 <span className="optional">{keyLabel}</span><input name="openAiKey" type="password" autoComplete="new-password" placeholder={settings.openAiKeyPresent?'변경할 때만 입력':'sk-로 시작하는 키를 붙여넣으세요'} autoFocus={!settings.openAiKeyPresent}/></label>
  <p className="small-copy">키는 <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">platform.openai.com/api-keys</a>에서 만들 수 있습니다. 이 컴퓨터의 앱 데이터 폴더(<code>secrets.json</code>)에만 저장되고 화면이나 로그에 다시 표시되지 않습니다.</p>
  <label>실시간 회의록 모델<select name="liveModel" defaultValue={settings.liveModel} disabled={busy}>{models.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
  <label>최종 회의록 모델<select name="finalModel" defaultValue={settings.finalModel} disabled={busy}>{models.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
  <p className="small-copy">받아쓰기는 <strong>gpt-transcribe</strong>(분당 약 $0.0045), 실시간 자막은 <strong>gpt-live-transcribe</strong>(분당 약 $0.017)를 씁니다. 회의록은 회의 초반 2분, 길어지면 최대 5분 간격으로 갱신되고 이미 보낸 받아쓰기는 할인된 캐시 요금으로 다시 읽습니다.</p>
  <label className="check-label"><input name="realtimeSttEnabled" type="checkbox" defaultChecked={settings.realtimeSttEnabled}/>실시간 자막 사용 (끄면 30초 단위 받아쓰기만 표시, 비용 약 80% 절감)</label>
  {error&&<div className="inline-error" role="alert">{error}</div>}{result&&<div className="inline-success" role="status">{result}</div>}
  <div className="button-row"><button className="primary" disabled={busy}>{busy?'확인 중…':'저장하고 연결 확인'}</button></div>
 </form>;
}
function HelpContent() {
 return <div className="help-content"><div><span>1</span><section><h3>회의를 준비해요</h3><p>‘새 회의’에서 이름을 정하고 회의 방식을 고르세요. 모여서 하는 회의는 ‘회의실’, 화상 회의는 ‘온라인 회의’입니다.</p></section></div><div><span>2</span><section><h3>소리를 확인해요</h3><p>‘소리 확인’을 누르면 음량 막대만 보여줍니다. 저장·전송하지 않습니다. 처음 한 번 브라우저가 마이크 권한을 물으면 허용하세요.</p><p>회의실에서는 노트북이나 마이크를 테이블 가운데에 두면 4~5명 목소리도 고르게 들어옵니다. 노트북 팬 소음이 큰 자리는 피하세요.</p></section></div><div><span>3</span><section><h3>녹음하고, 종료하면 끝</h3><p>참석자에게 녹음 사실을 알린 뒤 시작하세요. 온라인 회의는 시작할 때 공유 창이 뜹니다. 회의 탭(또는 화면)을 고르고 <strong>오디오 공유</strong>를 켜세요. ‘회의 종료’를 누르면 남은 받아쓰기와 최종 회의록까지 자동으로 만듭니다.</p><p>녹음 중에는 이 탭을 닫지 마세요. 실수로 닫았다면 다시 열어 ‘녹음 이어가기’를 누르면 됩니다. 저장된 음성은 남아 있습니다.</p></section></div><div><span>4</span><section><h3>다시 보고 가져가요</h3><p>회의록의 근거 시간을 누르면 받아쓰기 원문으로 이동합니다. 받아쓰기는 직접 교정할 수 있고, 교정하면 회의록을 다시 정리합니다. 내보내기에서 Markdown·TXT·원본 음성을 받을 수 있습니다.</p><p>한 마이크로 녹음하므로 누가 말했는지는 자동으로 구분하지 않습니다. 대화 중 이름이 불린 경우에만 회의록에 담당자를 적습니다.</p></section></div><p className="small-copy">앱을 완전히 끄려면 설정 화면 아래의 ‘앱 종료’ 또는 바탕화면의 ‘회의록 종료’ 바로가기를 사용하세요.</p></div>;
}

export default function App() {
 const [meetings,setMeetings]=useState<Meeting[]>([]),[selected,setSelected]=useState(()=>localStorage.getItem('meeting-notes-selected')||''),[detail,setDetail]=useState<Meeting|null>(null);
 const [settings,setSettings]=useState<Settings|null>(null);
 const [modal,setModal]=useState<'new'|'settings'|'help'|null>(new URLSearchParams(location.search).has('settings')?'settings':null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[toast,setToast]=useState(''),[online,setOnline]=useState(true);
 const [search,setSearch]=useState(''),[transcriptSearch,setTranscriptSearch]=useState(''),[mode,setMode]=useState<Mode>('room'),[micDevice,setMicDevice]=useState(''),[consent,setConsent]=useState(false),[view,setView]=useState<'both'|'notes'|'transcript'>('both');
 const [highlight,setHighlight]=useState(''),[follow,setFollow]=useState(true),[tick,setTick]=useState(0),[showExport,setShowExport]=useState(false);
 const [devices,setDevices]=useState<MediaDeviceInfo[]>([]),[levels,setLevels]=useState({mic:0,shared:0}),[heard,setHeard]=useState({mic:false,shared:false});
 const [previewing,setPreviewing]=useState(false),[recordingId,setRecordingId]=useState(''),[startedAt,setStartedAt]=useState({at:0,base:0}),[live,setLive]=useState<Live>({partial:'',captions:[],status:'',message:''}),[warning,setWarning]=useState(''),[backlogMs,setBacklogMs]=useState(0);
 const transcriptPane=useRef<HTMLDivElement>(null),audio=useRef<HTMLAudioElement>(null),selectedRef=useRef(selected),pendingSeek=useRef<number|null>(null);
 const recorder=useRef<LectureRecorder|null>(null),preview=useRef<InputPreview|null>(null);
 selectedRef.current=selected;
 const [libraryOpen,setLibraryOpen]=useState(false);
 const closeModal=useCallback(()=>setModal(null),[]);
 const refreshSettings=useCallback(()=>{void api<Settings>('/api/settings').then(setSettings).catch(()=>{});},[]);
 const refresh=useCallback(async()=>{
  try {
   const list=await api<Meeting[]>('/api/meetings');
   setMeetings(list);setOnline(true);
   const value=selectedRef.current;
   if(value){const data=await api<Meeting>(`/api/lectures/${value}`);if(selectedRef.current===value)setDetail(data);}
  }catch{setOnline(false);}
 },[]);
 const loadDevices=useCallback(()=>{void navigator.mediaDevices?.enumerateDevices().then(list=>setDevices(list.filter(d=>d.kind==='audioinput'&&d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications'))).catch(()=>{});},[]);
 const onLevels=useCallback((mic:number,shared:number)=>{setLevels({mic,shared});if(mic>0.004||shared>0.004)setHeard(h=>({mic:h.mic||mic>0.004,shared:h.shared||shared>0.004}));},[]);
 useEffect(()=>{void refresh();refreshSettings();loadDevices();navigator.mediaDevices?.addEventListener?.('devicechange',loadDevices);const timer=window.setInterval(()=>void refresh(),2500);return()=>{clearInterval(timer);navigator.mediaDevices?.removeEventListener?.('devicechange',loadDevices);};},[refresh,refreshSettings,loadDevices]);
 useEffect(()=>{const timer=window.setInterval(()=>setTick(n=>n+1),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{localStorage.setItem('meeting-notes-selected',selected);setDetail(null);setHighlight('');setTranscriptSearch('');setShowExport(false);if(selected)void api<Meeting>(`/api/lectures/${selected}`).then(value=>{if(selectedRef.current!==selected)return;setDetail(value);if(!recordingId)setMode(value.captureMode==='online'?'online':'room');setConsent(value.status!=='draft');}).catch(e=>setError(e.message));},[selected]);
 useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(''),4200);return()=>clearTimeout(timer);},[toast]);
 useEffect(()=>{if(follow&&transcriptPane.current)transcriptPane.current.scrollTop=transcriptPane.current.scrollHeight;},[detail?.segments.length,live.partial,follow]);
 useEffect(()=>{if(!recordingId)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[recordingId]);
 useEffect(()=>{if(settings&&!settings.openAiKeyPresent&&!modal)setModal('settings');},[settings?.openAiKeyPresent]);
 async function act(label:string,work:()=>Promise<unknown>){setBusy(label);setError('');try{await work();await refresh();}catch(e){setError((e as Error).message);}finally{setBusy('');}}
 function select(id:string){setLibraryOpen(false);setSelected(id);setError('');setFollow(true);}
 const options=():CaptureOptions=>({micDeviceId:micDevice,includeShared:mode==='online'});
 async function stopPreview(){await preview.current?.stop();setPreviewing(false);}
 async function togglePreview(){
  if(previewing){await stopPreview();return;}
  const p=preview.current||(preview.current=new InputPreview());
  p.onLevels=onLevels;p.onWarning=setWarning;setHeard({mic:false,shared:false});
  await p.start(options());setPreviewing(true);loadDevices();
 }
 function makeRecorder(lectureId:string){
  const r=new LectureRecorder();
  r.onLevels=onLevels;
  r.onWarning=setWarning;
  r.onBuffered=setBacklogMs;
  r.onFatal=message=>{setError(message);setRecordingId('');void post(`/api/meetings/${lectureId}/pause`).catch(()=>{}).then(()=>refresh());};
  r.onTranscriptPartial=text=>setLive(l=>({...l,partial:text}));
  r.onTranscriptCommitted=text=>setLive(l=>({...l,partial:'',captions:[...l.captions.slice(-4),text]}));
  r.onTranscriptStatus=(status,message)=>setLive(l=>({...l,status,message:message||''}));
  return r;
 }
 const start=()=>act('start',async()=>{
  if(!settings?.openAiKeyPresent){setModal('settings');throw new Error('먼저 OpenAI API 키를 저장하세요.');}
  await stopPreview();
  await post(`/api/meetings/${selected}/start`,{mode,consentConfirmed:consent});
  const r=recorder.current||(recorder.current=makeRecorder(selected));
  try{await r.start(selected,options());}
  catch(e){recorder.current=null;const err=e as Error;
   // A lock conflict means another tab owns this recording: never pause it from here.
   if(!err.message.includes('다른 탭'))await post(`/api/meetings/${selected}/pause`).catch(()=>{});throw new Error(err.name==='NotAllowedError'?(mode==='online'?'화면 공유 또는 마이크 권한이 거부되었습니다. 다시 시도하고 공유 창에서 오디오 공유를 켜세요.':'마이크 권한이 거부되었습니다. 주소창 왼쪽의 사이트 설정에서 마이크를 허용하세요.'):err.message);}
  setRecordingId(selected);setStartedAt({at:Date.now(),base:detail?.recordedMs||0});setLive({partial:'',captions:[],status:'',message:''});setWarning('');loadDevices();
 });
 async function stopRecorder(){const r=recorder.current;recorder.current=null;setRecordingId('');if(r)await r.stop();}
 const pause=()=>act('pause',async()=>{await stopRecorder();await post(`/api/meetings/${selected}/pause`);});
 const finish=()=>act('finish',async()=>{
  await stopRecorder();
  // Audio still buffered in this browser (server hiccup, or a tab closed mid-meeting) is uploaded before closing the meeting.
  if(await bufferedAudioMs(selected).catch(()=>0)>0){
   setToast('아직 보내지 못한 음성을 마저 저장하고 있습니다…');
   await post(`/api/meetings/${selected}/start`,{consentConfirmed:true,mode});
   const remaining=await makeRecorder(selected).flushOnly(selected);
   setBacklogMs(remaining);
   if(remaining>0&&!window.confirm(`${Math.ceil(remaining/1000)}초 분량의 음성을 아직 앱에 저장하지 못했습니다. 그래도 회의를 종료할까요?\n(취소하면 일시정지 상태로 남고, 나중에 ‘녹음 이어가기’로 다시 보낼 수 있습니다.)`)){await post(`/api/meetings/${selected}/pause`);return;}
  }
  await post(`/api/meetings/${selected}/finish`);
 });
 const deleteMeeting=()=>{if(!detail||!window.confirm(`‘${detail.title}’ 기록과 음성을 삭제할까요? 되돌릴 수 없습니다.`))return;void act('delete',async()=>{await remove(`/api/lectures/${detail.id}`);select('');});};
 const recording=Boolean(recordingId)&&recordingId===selected;
 const otherRecording=meetings.find(m=>m.status==='recording'&&m.id!==selected);
 const elsewhere=Boolean(detail?.liveRecorder)&&!recording; // another tab or browser is streaming this meeting
 const orphaned=detail?.status==='recording'&&!recording&&!elsewhere; // e.g. the tab was closed mid-meeting
 const elapsed=recording?startedAt.base+(Date.now()-startedAt.at):detail?.recordedMs||0;
 const blocked=Boolean(busy||!online),canStart=detail&&!elsewhere&&(['draft','paused'].includes(detail.status)||orphaned);
 const pending=detail?.chunks.filter(c=>c.status!=='done')||[],failed=pending.filter(c=>['failed','budget_blocked'].includes(c.status));
 // A finished meeting has nothing left to refresh, so leftover job errors are not shown.
 const noteJob=detail&&detail.status!=='complete'?detail.noteJobs?.find(j=>j.kind===(detail.status==='processing'?'final':'live')):undefined;
 const liveUpdating=noteJob?.state==='updating';
 const filtered=meetings.filter(m=>`${m.title} ${m.speaker}`.toLowerCase().includes(search.toLowerCase()));
 const visibleSegments=detail?.segments.filter(s=>!transcriptSearch||(s.overrideText||s.rawText).toLowerCase().includes(transcriptSearch.toLowerCase()))||[];
 const inputActive=previewing||recording;
 const source=(value:string)=>{
  if(!detail)return;
  const target=parseSourceTarget(value);if(target&&target.lectureId!==selected){select(target.lectureId);return;}
  const match=/SOURCE:([^\s@]+)/.exec(value);
  const id=target?.segmentId||match?.[1]||nearestSegmentId(detail.segments,timestampToMs(value)||0);
  const segment=detail.segments.find(s=>s.id===id);if(!segment)return;
  setView('both');setFollow(false);setTranscriptSearch('');setHighlight(segment.id);
  window.setTimeout(()=>document.getElementById(sourceAnchorId(selected,segment.id))?.scrollIntoView({behavior:'smooth',block:'center'}),60);
 };
 function seek(ms:number){if(!audio.current){setToast('일시정지 또는 회의 종료 후 이 위치를 재생할 수 있습니다.') ;return;}pendingSeek.current=ms/1000;if(audio.current.readyState===0)audio.current.load();else audio.current.currentTime=ms/1000;setToast(`${time(ms)} 위치로 이동했습니다. 재생 버튼으로 들을 수 있습니다.`);}
 async function copy(value:string){try{await navigator.clipboard.writeText(value);setToast('클립보드에 복사했습니다.');}catch{setError('클립보드에 접근할 수 없습니다. 파일로 내려받아 주세요.');}}
 async function quit(){if(recordingId&&!window.confirm('녹음을 저장하고 앱을 종료할까요?'))return;await stopRecorder();await post('/api/app/shutdown').catch(()=>{});setOnline(false);setToast('앱을 종료했습니다. 바탕화면 바로가기로 다시 열 수 있습니다.');}
 const keyMissing=settings&&!settings.openAiKeyPresent;
 return <div className="app-shell">
  <aside className={`sidebar ${libraryOpen?'library-open':''}`}><button className="brand" onClick={()=>select('')} aria-label="회의록 홈"><span className="brand-symbol"><Icon name="note" size={23}/></span><span>회의록<small>MEETING NOTES</small></span></button><button className="new-meeting primary" onClick={()=>{setError('');setModal('new');}} disabled={Boolean(recordingId)||blocked}><Icon name="plus"/>새 회의</button><div className="mobile-tools"><button onClick={()=>setLibraryOpen(v=>!v)} aria-expanded={libraryOpen}>내 기록 {meetings.length}</button><button onClick={()=>setModal('settings')}>설정</button><button onClick={()=>setModal('help')}>사용 안내</button></div><div className="library-heading"><span>내 기록</span><span>{meetings.length}</span></div><label className="search-field"><Icon name="search" size={16}/><input aria-label="기록 검색" placeholder="이름·참가자 검색" value={search} onChange={e=>setSearch(e.target.value)}/></label><nav className="meeting-list" aria-label="저장된 회의">{filtered.map(m=><button key={m.id} className={`meeting-item ${selected===m.id?'selected':''}`} onClick={()=>select(m.id)}><span className={`list-icon ${m.status==='recording'?'recording':''}`}><Icon name={m.status==='recording'?'mic':'note'} size={18}/></span><span className="list-text"><strong>{m.title}</strong><small>{new Date(m.createdAt).toLocaleDateString('ko-KR',{month:'short',day:'numeric'})} · {statusLabel[m.status]}</small></span>{m.status==='recording'&&<i className="record-dot"/>}</button>)}{!filtered.length&&<p className="library-empty">{search?'일치하는 기록이 없습니다.':'첫 번째 회의를 시작해 보세요.'}</p>}</nav><div className="sidebar-bottom"><div className="local-status"><span className={online?'online-dot':'offline-dot'}/>{online?'이 컴퓨터에 저장 중':'앱 연결 끊김'}</div><button onClick={()=>setModal('settings')}><Icon name="settings" size={18}/>설정</button><button onClick={()=>setModal('help')}><Icon name="help" size={18}/>사용 안내</button></div></aside>
  <main className="workspace">
   {!online&&<div className="connection-banner" role="alert">앱에 연결할 수 없습니다. 바탕화면의 ‘회의록’ 바로가기(또는 <code>npm start</code>)로 다시 실행하세요.<button onClick={()=>void refresh()}>다시 연결</button></div>}
   {otherRecording&&<div className="connection-banner active-banner"><span className="record-dot"/>진행 중인 회의가 있습니다.<button onClick={()=>select(otherRecording.id)}>녹음 화면으로 이동<Icon name="arrow" size={16}/></button></div>}
   {!selected?<><header className="home-topbar"><span>나의 회의 공간</span><span className="model-label"><Icon name="bolt" size={15}/>gpt-transcribe · {settings?.liveModel||'…'}</span></header><div className="home-content"><div className="hero-eyebrow">대화에 집중하세요.</div><h1>기록은 여기에<br/><span>남겨둘게요.</span></h1><p className="hero-description">테이블에 둘러앉은 회의도, 화상 회의도.<br/>받아쓰기부터 결정 사항, 다음 할 일까지 한곳에 정리합니다.</p>{keyMissing?<button className="primary hero-button" onClick={()=>setModal('settings')}><Icon name="settings"/>먼저 OpenAI 키 연결하기<Icon name="arrow" size={18}/></button>:<button className="primary hero-button" disabled={Boolean(recordingId)||blocked} onClick={()=>{setError('');setModal('new');}}><Icon name="plus"/>새 회의 준비하기<Icon name="arrow" size={18}/></button>}<div className="journey"><div><span>01</span><h3>소리 확인</h3><p>마이크가 모두의 목소리를<br/>받는지 먼저 확인해요.</p></div><div><span>02</span><h3>대화에 집중</h3><p>음성과 받아쓰기는<br/>계속 저장돼요.</p></div><div><span>03</span><h3>바로 보는 회의록</h3><p>종료하면 결정과 할 일을<br/>자동으로 정리해요.</p></div></div><section className="recent-section"><div className="section-heading"><h2>최근 기록</h2><span>{meetings.length}개의 기록</span></div>{meetings.slice(0,3).map(m=><button className="recent-row" key={m.id} onClick={()=>select(m.id)}><span className="recent-icon"><Icon name="note"/></span><span><strong>{m.title}</strong><small>{date(m.createdAt)} · {time(m.recordedMs)}</small></span><span className={`pill ${m.status==='complete'?'green':''}`}>{statusLabel[m.status]}</span><Icon name="arrow" size={17}/></button>)}{!meetings.length&&<div className="empty-recent">회의가 끝나면 이곳에서 다시 볼 수 있어요.</div>}</section></div><div className="home-art" aria-hidden="true"><div className="paper paper-back"/><div className="paper paper-front"><span className="art-label">CONVERSATION → CLARITY</span><div className="art-wave">{[16,30,52,34,68,88,48,72,40,60,24,48,76,55,32,62,83,49,24].map((height,i)=><i key={i} style={{height}}/>)}</div><div className="art-rule"/><div className="art-line wide"/><div className="art-line"/><div className="art-task"><span>✓</span><i/></div><div className="art-task"><span>✓</span><i/></div><div className="art-sticker"><Icon name="bolt" size={15}/>생각이 다음 행동으로</div></div></div></>:
   !detail?<div className="loading-state"><span className="spinner"/>기록을 불러오는 중입니다.</div>:<>
    <header className="meeting-header"><div className="meeting-heading"><div className="breadcrumb"><button onClick={()=>select('')}>내 기록</button><span>/</span>회의</div><div className="title-line"><h1>{detail.title}</h1><span className={`pill ${recording?'red':detail.status==='complete'?'green':''}`}>{orphaned?'녹음 중단됨':statusLabel[detail.status]}</span></div><p>{date(detail.createdAt)}{detail.speaker&&` · ${detail.speaker}`}</p></div><div className="header-actions"><span className="model-label"><Icon name="bolt" size={15}/>{settings?.liveModel||''}</span><div className="export-wrapper"><button disabled={!detail.segments.length} onClick={()=>setShowExport(v=>!v)} aria-expanded={showExport}><Icon name="download" size={17}/>내보내기</button>{showExport&&<div className="export-menu"><button onClick={()=>void copy(detail.finalNote||detail.segments.map(s=>`[${time(s.startMs)}] ${s.overrideText||s.rawText}`).join('\n\n'))}><Icon name="copy" size={16}/>내용 복사</button><a href={`/api/lectures/${selected}/export/md`} download>회의록 Markdown</a><a href={`/api/lectures/${selected}/export/txt`} download>받아쓰기 TXT</a><a href={`/api/lectures/${selected}/export/json`} download>전체 데이터 JSON</a>{detail.recordedMs>0&&detail.status!=='recording'&&<a href={`/api/lectures/${selected}/audio.flac`} download>원본 음성 FLAC</a>}</div>}</div>{!recording&&detail.status!=='recording'&&<button className="icon-button" aria-label="회의 삭제" title="회의 삭제" disabled={blocked} onClick={deleteMeeting}><Icon name="close" size={17}/></button>}</div></header>
    {error&&modal!=='new'&&<div className="error-banner" role="alert"><span>{error}</span><button aria-label="오류 닫기" onClick={()=>setError('')}><Icon name="close" size={16}/></button></div>}
    {warning&&(recording||previewing)&&<div className="subtle-notice" role="status">{warning}<button className="text-button" onClick={()=>setWarning('')}>닫기</button></div>}
    {elsewhere&&<div className="subtle-notice">이 회의는 다른 탭이나 창에서 녹음 중입니다. 그 창에서 일시정지하거나 종료하세요.</div>}
    {backlogMs>0&&<div className="subtle-notice">아직 앱에 저장하지 못한 음성 {Math.ceil(backlogMs/1000)}초가 이 브라우저에 보관되어 있습니다. 연결되면 자동으로 보냅니다.</div>}
    {orphaned&&<div className="subtle-notice">이 회의는 녹음 중에 창이 닫혀 녹음이 멈췄습니다. 저장된 음성은 그대로 있습니다. ‘녹음 이어가기’ 또는 ‘회의 종료’를 누르세요.</div>}
    {(canStart||recording)&&<section className={`setup-panel ${recording?'compact':''}`}><div className="setup-main"><div className="setup-title"><span className="step-circle">{recording?<Icon name="check" size={16}/>:1}</span><div><h2>{recording?'회의를 기록하고 있어요':'시작하기 전에 소리부터 확인해요'}</h2><p>{recording?'이 탭을 닫지 마세요. 다른 탭이나 창으로 이동하는 것은 괜찮습니다.':modeHint[mode]}</p></div></div>{!recording&&<><div className="source-options" role="radiogroup" aria-label="회의 방식">{(['room','online'] as Mode[]).map(m=><button key={m} role="radio" aria-checked={mode===m} disabled={blocked||previewing} className={mode===m?'chosen':''} onClick={()=>{setMode(m);if(m==='room'&&micDevice==='off')setMicDevice('');}}><Icon name={m==='room'?'mic':'headset'} size={18}/>{modeLabel[m]}{mode===m&&<Icon name="check" size={14}/>}</button>)}</div><div className="device-row"><label>마이크<select aria-label="마이크" value={micDevice} onChange={e=>setMicDevice(e.target.value)} disabled={blocked||previewing}><option value="">기본 마이크</option>{devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.label||'마이크'}</option>)}{mode==='online'&&<option value="off">마이크 제외 (상대방 소리만)</option>}</select></label><button disabled={blocked} onClick={()=>void act('preview',togglePreview)}>{busy==='preview'?<span className="spinner"/>:<Icon name={previewing?'stop':'sound'} size={16}/>} {previewing?'소리 확인 종료':'소리 확인'}</button></div>{mode==='online'&&<p className="small-copy">소리 확인과 녹음 시작 때 공유 창이 뜹니다. 회의 중인 탭(또는 화면 전체)을 고르고 <strong>{isWindows?'시스템 오디오 공유':'탭 오디오 공유'}</strong>를 켜세요. {isWindows?'Windows에서는 화면 전체 공유로 Zoom·Discord 앱 소리도 받을 수 있습니다.':'macOS에서는 브라우저 탭의 소리만 받을 수 있으므로 회의를 Chrome 탭에서 여세요.'} 스피커 대신 이어폰을 쓰면 소리가 겹치지 않습니다.</p>}</>}</div><div className="meter-panel">{mode==='online'&&<Meter label="상대방 · 공유한 화면 소리" level={levels.shared} heard={heard.shared} active={inputActive} icon="headset"/>}{micDevice!=='off'&&<Meter label={mode==='room'?'회의실 마이크':'내 마이크'} level={levels.mic} heard={heard.mic} active={inputActive} icon="mic"/>}<p>{inputActive?'말할 때 막대가 움직이면 연결된 거예요.':mode==='room'?'테이블 반대편 사람도 한마디 해서 막대가 움직이는지 보세요.':'대화 중 두 음량 막대가 움직이는지 확인하세요.'}</p></div></section>}
    {canStart&&!recording&&<div className="consent-strip"><label className="check-label"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>참석자에게 녹음·전사 사실을 알렸습니다.</label><span>처음 한 번 브라우저가 마이크 권한을 물으면 ‘허용’을 누르세요.</span></div>}
    {pending.length>0&&!recording&&<div className={`processing-banner ${failed.length?'warning':''}`}><span className={failed.length?'':'spinner'}/><div><strong>{failed.length?`${failed.length}개 구간의 받아쓰기를 확인해 주세요`:`남은 ${pending.length}개 음성 구간을 받아쓰고 있어요`}</strong><p>{failed.length?failed[0].error:'음성은 저장되었습니다. 받아쓰기가 끝나면 회의록도 자동으로 정리합니다.'}</p></div>{failed.length>0&&<button disabled={blocked} onClick={()=>void act('retry',async()=>{for(const chunk of failed)await post(`/api/chunks/${chunk.id}/retry`);await post(`/api/meetings/${selected}/notes/retry`);})}>다시 시도</button>}</div>}
    {recording&&live.message&&live.status!=='connected'&&<div className="subtle-notice">실시간 자막 연결을 확인하고 있습니다. 음성은 저장되며 30초 단위 받아쓰기는 계속됩니다.<details><summary>자세히</summary>{live.message}</details></div>}
    <div className="content-toolbar"><div className="view-switch" aria-label="보기 방식">{([['both','나란히 보기'],['notes','회의록'],['transcript','받아쓰기']] as const).map(([v,label])=><button className={view===v?'active':''} onClick={()=>setView(v)} key={v}>{label}</button>)}</div><span className="save-label"><Icon name="check" size={14}/>{recording?'원본 자동 저장':'이 컴퓨터에 보관됨'}</span></div>
    <div className={`content-panes view-${view}`}>
     <section className="notes-pane"><header className="pane-header"><h2><Icon name="note" size={18}/>회의록</h2><span>{liveUpdating?<><span className="spinner tiny"/>갱신 중</>:detail.liveNote?.updatedAt?`${new Date(detail.liveNote.updatedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})} 갱신`:detail.status==='complete'?'최종 정리':''}</span></header>
      {(noteJob?.state==='retrying'||noteJob?.state==='error'||detail.noteStatus==='error')&&<div className="note-error" role="status"><strong>{noteJob?.state==='retrying'?`회의록 갱신을 ${Math.max(0,Math.ceil((new Date(noteJob.retryAt).getTime()-Date.now())/1000))}초 뒤 다시 시도합니다`:'회의록 정리를 다시 시도해 주세요'}</strong><p>{noteJob?.error||detail.noteError}</p><p>마지막 정상 회의록과 원문은 그대로 보관되어 있습니다.</p><button disabled={blocked} onClick={()=>void act('notes',()=>post(`/api/meetings/${selected}/notes/retry`))}>다시 정리</button></div>}
      <div className="note-scroll">{detail.finalNote?<div className="note-document final-document"><div className="document-eyebrow"><Icon name="check" size={14}/>{detail.status==='processing'?'이전 회의록 · 최신 원문으로 다시 정리 중':'FINAL NOTES'}</div><SourceNavigation.Provider value={source}><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{detail.finalNote}</ReactMarkdown></SourceNavigation.Provider><button className="text-button" onClick={()=>void act('regenerate',()=>post(`/api/meetings/${selected}/notes/retry`,{force:true}))} disabled={blocked}><Icon name="refresh" size={15}/>최종 회의록 다시 만들기</button></div>:detail.liveNote?<LiveDocument note={detail.liveNote} onSource={source}/>:<div className="note-empty"><div className="empty-icon"><Icon name="bolt" size={27}/></div><h3>{detail.noteStatus==='generating'?'회의 전체를 정리하고 있어요':'대화가 다음 행동이 되는 곳'}</h3><p>{detail.noteStatus==='generating'?'잠시만 기다려 주세요. 결정과 할 일을 원문에 맞춰 확인합니다.':'첫 받아쓰기 후 회의록이 나타나고, 대화가 쌓이면 몇 분마다 자동으로 갱신됩니다.'}</p><div className="empty-outline"><div><span className="outline-check"><Icon name="check" size={13}/></span><strong>결정 사항</strong><i/></div><div><Icon name="star" size={14}/><strong>다음 할 일</strong><i/></div><div><Icon name="help" size={14}/><strong>남은 질문</strong><i/></div></div><span className="empty-footnote">근거 시간을 누르면 원문으로 이동합니다.</span></div>}</div>
     </section>
     <section className="transcript-pane"><header className="pane-header"><h2><Icon name="mic" size={18}/>받아쓰기<span className="count">{detail.segments.length}</span></h2><label className="follow-label"><input type="checkbox" checked={follow} onChange={e=>setFollow(e.target.checked)}/>자동 스크롤</label></header><div className="transcript-search"><Icon name="search" size={15}/><input aria-label="받아쓰기 검색" placeholder="대화에서 찾기" value={transcriptSearch} onChange={e=>{setTranscriptSearch(e.target.value);setFollow(false);}}/></div><div className="transcript-scroll" ref={transcriptPane}>{visibleSegments.map(segment=><Segment key={segment.id} lectureId={selected} segment={segment} onSaved={()=>void refresh()} onSeek={seek} highlight={highlight===segment.id}/>)}{recording&&!transcriptSearch&&(live.partial||live.captions.length>0)&&<div className="live-caption"><div><span className="live-dot"/>실시간 미리보기</div>{live.captions.slice(-2).map((text,i)=><p key={i}>{text}</p>)}<p className="partial">{live.partial}</p><small>약 30초마다 정밀 받아쓰기로 저장됩니다.</small></div>}{!visibleSegments.length&&!(recording&&live.partial)&&<div className="transcript-empty"><Icon name={recording?'mic':'headset'} size={30}/><h3>{transcriptSearch?'검색 결과가 없습니다':recording?'목소리를 기다리고 있어요':'첫 마디부터 남겨둘게요'}</h3><p>{recording?'말씀하시면 이곳에 받아쓰기가 나타납니다.':'녹음을 시작하면 대화가 시간과 함께 쌓입니다.'}</p></div>}</div>{detail.bookmarks.length>0&&<div className="bookmarks">{detail.bookmarks.map(b=><button key={b.id} onClick={()=>source(time(b.atMs))}><Icon name="star" size={13}/>{time(b.atMs)}{b.note&&` ${b.note}`}</button>)}</div>}{detail.recordedMs>0&&!recording&&detail.status!=='recording'&&detail.originalAudioPresent&&<div className="audio-player"><audio ref={audio} controls preload="none" src={`/api/lectures/${selected}/audio.flac`} onLoadedMetadata={()=>{if(pendingSeek.current!==null&&audio.current){audio.current.currentTime=pendingSeek.current;pendingSeek.current=null;}}}/></div>}</section>
    </div>
    <footer className="record-dock"><div className="record-time"><span className={recording?'record-dot pulsing':'idle-record-dot'}/><strong>{time(elapsed)}</strong><span>{recording?'녹음 중':orphaned?'녹음이 멈춤':detail.status==='paused'?'잠시 쉬는 중':detail.status==='complete'?'회의가 정리되었습니다':detail.status==='processing'?'녹음 저장 완료':'시작할 준비가 되었어요'}</span></div><div className="dock-actions">{recording&&<><button className="bookmark-button" disabled={blocked} onClick={()=>void act('bookmark',async()=>{await post(`/api/lectures/${selected}/bookmarks`,{atMs:elapsed});setToast('중요한 순간을 표시했습니다.');})}><Icon name="star" size={18}/>중요 표시</button><button disabled={blocked} onClick={()=>void pause()}><Icon name="pause" size={17}/>일시정지</button></>}{(recording||detail.status==='paused'||orphaned)&&!elsewhere&&<button className="finish-button" disabled={blocked} onClick={()=>void finish()}><Icon name="stop" size={16}/>{busy==='finish'?'저장 중…':'회의 종료'}</button>}{canStart&&!recording&&<button className="primary record-start" disabled={blocked||!consent||Boolean(otherRecording)||Boolean(recordingId)} onClick={()=>void start()}>{busy==='start'?<span className="spinner"/>:<Icon name={detail.status==='draft'?'mic':'play'} size={19}/>} {busy==='start'?'연결 중…':detail.status==='draft'?'녹음 시작':'녹음 이어가기'}</button>}{detail.status==='complete'&&<button className="primary" onClick={()=>void copy(detail.finalNote)}><Icon name="copy" size={17}/>회의록 복사</button>}</div></footer>
   </>}
  </main>
  {toast&&<div className="toast" role="status"><Icon name="check" size={17}/>{toast}</div>}
  {modal&&<Modal title={modal==='new'?'새 회의':modal==='settings'?'연결 및 설정':'이렇게 사용하세요'} onClose={closeModal}>{modal==='new'?<NewMeeting busy={Boolean(busy)} error={error} onCreate={body=>void act('new',async()=>{const meeting=await post<Meeting>('/api/meetings',body);select(meeting.id);setMode((body as any).captureMode==='online'?'online':'room');setModal(null);setConsent(false);})}/>:modal==='settings'?<><SettingsForm settings={settings} onSaved={refreshSettings}/><div className="button-row quit-row"><button type="button" onClick={()=>void quit()}><Icon name="stop" size={15}/>앱 종료</button></div></>:<HelpContent/>}</Modal>}
  <span className="sr-only" aria-hidden="true">{tick}</span>
 </div>;
}
