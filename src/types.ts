export interface ReflectionData {
  student_id: string;
  name: string;
  reflection: string;
  timestamp: string;
}

export interface FirestoreReflection extends ReflectionData {
  id: string;
  createdAt: any;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
