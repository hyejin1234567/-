import { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
  Send, 
  User, 
  Bot, 
  Download, 
  Settings, 
  ChevronLeft, 
  Trash2, 
  LogOut, 
  UserCircle,
  ClipboardList
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  addDoc, 
  query, 
  orderBy, 
  onSnapshot, 
  serverTimestamp,
  deleteDoc,
  doc
} from 'firebase/firestore';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { db, auth, signInWithGoogle } from './firebase';
import { cn } from './lib/utils';
import { Message, ReflectionData, FirestoreReflection } from './types';
import { format } from 'date-fns';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const SYSTEM_INSTRUCTION = `
너는 중학교 학생들의 계기교육 소감문을 수집하고 정리하는 행정 보조 AI 비서, '지혜 샘'이다.
학생이 학번, 이름, 소감문을 입력하면 친절하게 응답하고, 내용을 추출하여 [DATA]...[/DATA] 태그 안에 JSON 형식으로 출력해야 한다.

[행동 지침]
1. 중학교 선생님처럼 따뜻하고 격려하는 어투(~했어요, ~ 바랍니다, ~님 등)를 사용한다.
2. 학생이 학번, 이름, 소감문 중 누락된 정보가 있으면 친절하게 물어본다.
3. 소감문 내용이 "재밌었다", "좋았다", "없음", "모르겠다"와 같이 너무 짧거나 성의가 없으면, 
   "조금 더 구체적으로 어떤 점이 인상 깊었는지, 배운 점은 무엇인지 한 문장만 더 적어볼 수 있을까? 선생님은 너의 깊은 생각이 궁금하단다!"와 같이 부드럽게 격려한다.
4. 모든 필수 정보(학번, 이름, 소감문)가 있고 소감문이 충분히 정성스럽다면, "소중한 소감문 작성해줘서 정말 고마워요. 선생님이 잘 정리해서 교실 게시판에도 참고할게요! 수고 많았어요."라고 인사하며 마무리한다.
5. 모든 응답의 마지막에는 반드시 [DATA]...[/DATA] 태그 안에 JSON 형태로 파싱된 데이터를 포함해야 한다. 
   정보가 아직 다 수집되지 않았다면 해당하는 값에 "N/A"를 넣는다.

[JSON 출력 형식]
{
  "student_id": "추출된 학번 (예: 10324)",
  "name": "추출된 이름",
  "reflection": "추출된 소감문 내용",
  "timestamp": "현재 날짜 및 시간"
}
`;

export default function App() {
  const [view, setView] = useState<'chat' | 'admin'>('chat');
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: '안녕! 나는 계기교육 소감문 작성을 도와줄 지혜 샘이야. 소감문을 작성하기 위해 학번, 이름, 그리고 오늘 교육을 듣고 느낀 점을 편하게 적어주렴!' }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [reflections, setReflections] = useState<FirestoreReflection[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (view === 'admin' && user) {
      const q = query(collection(db, 'reflections'), orderBy('createdAt', 'desc'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const data = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as FirestoreReflection[];
        setReflections(data);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'reflections');
      });
      return () => unsubscribe();
    }
  }, [view, user]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      // Create a fresh instance for every call as per Gemini skill recommendation for potential API key updates
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          ...messages.map(m => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })),
          { role: 'user', parts: [{ text: userMessage }] }
        ],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        }
      });

      const assistantContent = response.text || "미안해, 다시 한 번 말해줄 수 있겠니?";
      setMessages(prev => [...prev, { role: 'assistant', content: assistantContent }]);

      // Extract JSON data
      const dataMatch = assistantContent.match(/\[DATA\]([\s\S]*?)\[\/DATA\]/);
      if (dataMatch) {
        try {
          const rawData = JSON.parse(dataMatch[1]);
          // Check if all data is fully collected and valid
          if (
            rawData.student_id !== 'N/A' && 
            rawData.name !== 'N/A' && 
            rawData.reflection !== 'N/A' && 
            rawData.reflection.length > 5 // Basic check for meaningful length
          ) {
            // Check if this is the final confirmation response
            if (assistantContent.includes("고마워요") || assistantContent.includes("수고 많았어요")) {
              try {
                await addDoc(collection(db, 'reflections'), {
                  ...rawData,
                  createdAt: serverTimestamp(),
                });
                console.log("Reflection saved to database!");
              } catch (err) {
                handleFirestoreError(err, OperationType.WRITE, 'reflections');
              }
            }
          }
        } catch (e) {
          console.error("Failed to parse JSON data", e);
        }
      }
    } catch (error) {
      console.error("Error from AI:", error);
      setMessages(prev => [...prev, { role: 'assistant', content: '앗, 잠시 오류가 발생했어. 다시 한 번 적어줄래?' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const exportToCSV = () => {
    if (reflections.length === 0) return;
    
    // Header
    const headers = ['학번', '이름', '소감문', '작성시간'];
    const rows = reflections.map(r => [
      r.student_id,
      r.name,
      `"${r.reflection?.replace(/"/g, '""')}"`,
      r.timestamp
    ]);
    
    const csvContent = "\uFEFF" + [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `소감문_취합_${format(new Date(), 'yyyyMMdd_HHmm')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const deleteReflection = async (id: string) => {
    if (window.confirm('정말 삭제하시겠습니까?')) {
      try {
        await deleteDoc(doc(db, 'reflections', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `reflections/${id}`);
      }
    }
  };

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto bg-white shadow-xl overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-indigo-600 text-white shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-white/20 rounded-xl">
            <ClipboardList className="w-6 h-6" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">계기교육 소감문 비서</h1>
        </div>
        <div className="flex gap-2">
          {view === 'chat' && (
            <button 
              onClick={() => {
                if(window.confirm('대화 내용을 초기화할까요?')) {
                  setMessages([{ role: 'assistant', content: '안녕! 나는 계기교육 소감문 작성을 도와줄 지혜 샘이야. 소감문을 작성하기 위해 학번, 이름, 그리고 오늘 교육을 듣고 느낀 점을 편하게 적어주렴!' }]);
                }
              }}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
              title="대화 초기화"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
          <button 
            onClick={() => setView(view === 'chat' ? 'admin' : 'chat')}
            className="p-2 hover:bg-white/10 rounded-full transition-colors"
            title={view === 'chat' ? '선생님 모드' : '학생 모드'}
          >
            {view === 'chat' ? <Settings className="w-5 h-5" /> : <ChevronLeft className="w-5 h-5" />}
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 relative overflow-hidden flex flex-col">
        {view === 'chat' ? (
          <>
            <div 
              ref={scrollRef}
              className="flex-1 overflow-y-auto px-6 py-8 space-y-6"
            >
              <AnimatePresence initial={false}>
                {messages.map((m, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      "flex gap-3",
                      m.role === 'user' ? "flex-row-reverse" : "flex-row"
                    )}
                  >
                    <div className={cn(
                      "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                      m.role === 'assistant' ? "bg-indigo-100 text-indigo-600" : "bg-slate-100 text-slate-600"
                    )}>
                      {m.role === 'assistant' ? <Bot size={18} /> : <User size={18} />}
                    </div>
                    <div className={cn(
                      "max-w-[80%] px-4 py-3 rounded-2xl text-sm leading-relaxed",
                      m.role === 'assistant' 
                        ? "bg-indigo-50 text-indigo-900 rounded-tl-none" 
                        : "bg-slate-100 text-slate-900 rounded-tr-none"
                    )}>
                      {m.role === 'assistant' ? (
                        <div className="markdown-body">
                          {m.content.replace(/\[DATA\][\s\S]*?\[\/DATA\]/, '').trim() || (isLoading ? "생각 중..." : "")}
                        </div>
                      ) : (
                        m.content
                      )}
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {isLoading && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center">
                    <Bot size={18} />
                  </div>
                  <div className="bg-indigo-50 text-indigo-900 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]" />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.4s]" />
                  </div>
                </div>
              )}
            </div>

            {/* Input Form */}
            <div className="p-4 bg-white border-t border-slate-100 shrink-0">
              <div className="relative flex items-center gap-2">
                <input 
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="학번, 이름, 소감문을 자유롭게 입력해주세요..."
                  className="flex-1 bg-slate-50 border-none rounded-full px-6 py-3 text-sm focus:ring-2 focus:ring-indigo-500 transition-all outline-none"
                  disabled={isLoading}
                />
                <button 
                  onClick={handleSend}
                  disabled={!input.trim() || isLoading}
                  className="bg-indigo-600 text-white p-3 rounded-full hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-all shadow-lg active:scale-95"
                >
                  <Send className="w-5 h-5" />
                </button>
              </div>
              <p className="text-[10px] text-slate-400 mt-2 text-center">
                선생님 비서가 소중한 의견을 잘 정리해 줄 거예요.
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col bg-white">
            <div className="px-6 py-4 flex items-center justify-between border-b border-slate-100 bg-slate-50/50">
              <div>
                <h2 className="font-semibold text-slate-800">소감문 취합 목록</h2>
                <p className="text-xs text-slate-500">{reflections.length}명의 학생이 제출함</p>
              </div>
              <div className="flex gap-2">
                {user ? (
                  <>
                    <button 
                      onClick={exportToCSV}
                      className="flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-2 rounded-lg text-xs font-medium hover:bg-indigo-200 transition-colors"
                    >
                      <Download size={14} /> 엑셀 다운로드
                    </button>
                    <button 
                      onClick={() => auth.signOut()}
                      className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                      title="로그아웃"
                    >
                      <LogOut size={18} />
                    </button>
                  </>
                ) : (
                  <button 
                    onClick={() => signInWithGoogle()}
                    className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-indigo-700 transition-colors"
                  >
                    로그인하여 데이터 보기
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {!user ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-4">
                  <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center">
                    <Settings className="w-8 h-8 opacity-20" />
                  </div>
                  <p className="text-sm">선생님 확인을 위해 로그인이 필요합니다.</p>
                </div>
              ) : reflections.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-2">
                  <ClipboardList className="w-12 h-12 opacity-10" />
                  <p className="text-sm">아직 제출된 소감문이 없습니다.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {reflections.map((r) => (
                    <div 
                      key={r.id}
                      className="group relative p-4 bg-white border border-slate-100 rounded-xl hover:border-indigo-200 hover:shadow-md transition-all"
                    >
                      <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">
                            {r.student_id}
                          </span>
                          <span className="text-sm font-semibold text-slate-800">{r.name}</span>
                        </div>
                        <button 
                          onClick={() => deleteReflection(r.id)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <p className="text-sm text-slate-600 leading-relaxed italic">
                        "{r.reflection}"
                      </p>
                      <div className="mt-3 pt-3 border-t border-slate-50 flex justify-between items-center text-[10px] text-slate-400">
                        <div className="flex items-center gap-1">
                          <UserCircle size={12} /> {r.name} 학생
                        </div>
                        <div>{r.timestamp}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
