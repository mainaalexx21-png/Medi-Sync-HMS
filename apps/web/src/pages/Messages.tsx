import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, timeOnly } from '../lib/format';
import { usePatients } from '../lib/hooks';
import {
  Alert, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, PageHeader, Textarea, useToast,
} from '../components/ui';

export default function Messages() {
  const { me } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const [newThread, setNewThread] = useState({ subject: '', body: '', patientId: '' });
  const [search, setSearch] = useState('');
  const patients = usePatients(search);

  const threads = useQuery({
    queryKey: ['threads'],
    queryFn: () => api.get<{ data: any[] }>('/messages/threads'),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    if (!selectedId && threads.data?.data?.length) setSelectedId(threads.data.data[0].id);
  }, [threads.data, selectedId]);

  const thread = useQuery({
    queryKey: ['thread', selectedId],
    queryFn: () => api.get<{ thread: any }>(`/messages/threads/${selectedId}`),
    enabled: Boolean(selectedId),
  });

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !selectedId) return;
    try {
      await api.post(`/messages/threads/${selectedId}/messages`, { body: draft });
      setDraft('');
      queryClient.invalidateQueries({ queryKey: ['thread', selectedId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Message not sent', 'danger');
    }
  }

  async function createThread(event: React.FormEvent) {
    event.preventDefault();
    try {
      const res = await api.post<any>('/messages/threads', newThread);
      toast.push('Conversation started', 'success');
      setComposing(false);
      setNewThread({ subject: '', body: '', patientId: '' });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      setSelectedId(res.thread.id);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not start the conversation', 'danger');
    }
  }

  const isPatientPortal = me?.portal === 'patient';

  return (
    <div>
      <PageHeader
        title="Secure messages"
        description="Private conversations between patients and their care team. Messages are part of the medical record."
        actions={!isPatientPortal && <Button onClick={() => setComposing(true)}>New conversation</Button>}
      />

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card>
          <CardHeader title="Conversations" subtitle={`${threads.data?.data?.length ?? 0} threads`} />
          {threads.isLoading ? (
            <Loading />
          ) : (threads.data?.data ?? []).length === 0 ? (
            <EmptyState title="No conversations" description={isPatientPortal ? 'Start one from your appointments page.' : 'Start a conversation with a patient.'} />
          ) : (
            <ul className="divide-y divide-slate-100">
              {threads.data!.data.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full px-4 py-3 text-left transition hover:bg-slate-50 ${selectedId === item.id ? 'bg-brand-50/60' : ''}`}
                  >
                    <p className="text-sm font-medium text-slate-800">{item.subject}</p>
                    <p className="text-xs text-slate-500">
                      {item.patient.firstName} {item.patient.lastName} · {timeOnly(item.lastMessageAt)}
                    </p>
                    {item.messages[0] && <p className="mt-0.5 truncate text-xs text-slate-400">{item.messages[0].body}</p>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="flex min-h-[420px] flex-col">
          {!selectedId ? (
            <EmptyState title="Select a conversation" />
          ) : thread.isLoading ? (
            <Loading />
          ) : thread.error ? (
            <div className="p-4">
              <Alert tone="danger">{thread.error instanceof ApiError ? thread.error.message : 'Could not open this conversation'}</Alert>
            </div>
          ) : (
            <>
              <CardHeader
                title={thread.data!.thread.subject}
                subtitle={`${thread.data!.thread.patient.firstName} ${thread.data!.thread.patient.lastName} · ${thread.data!.thread.patient.mrn}`}
              />
              <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
                {thread.data!.thread.messages.map((message: any) => {
                  const mine = message.senderId === me?.user.id;
                  return (
                    <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm ${mine ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-800'}`}>
                        <p>{message.body}</p>
                        <p className={`mt-1 text-[10px] ${mine ? 'text-brand-200' : 'text-slate-500'}`}>
                          {message.sender.role.toLowerCase()} · {dateTime(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <form className="flex gap-2 border-t border-slate-100 p-3" onSubmit={send}>
                <label htmlFor="draft" className="sr-only">
                  Message
                </label>
                <Input id="draft" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Write a message…" />
                <Button type="submit" disabled={!draft.trim()}>
                  Send
                </Button>
              </form>
            </>
          )}
        </Card>
      </div>

      <Modal open={composing} onClose={() => setComposing(false)} title="New conversation">
        <form className="space-y-3" onSubmit={createThread}>
          <Field label="Search patient" htmlFor="mt-search">
            <Input id="mt-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, MRN or phone" />
          </Field>
          <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200">
            {(patients.data?.data ?? []).map((patient) => (
              <button
                type="button"
                key={patient.id}
                onClick={() => setNewThread({ ...newThread, patientId: patient.id })}
                className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-slate-50 ${newThread.patientId === patient.id ? 'bg-brand-50' : ''}`}
              >
                <span>
                  {patient.firstName} {patient.lastName}
                </span>
                <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
              </button>
            ))}
          </div>
          <Field label="Subject" htmlFor="mt-subject" required>
            <Input id="mt-subject" required value={newThread.subject} onChange={(event) => setNewThread({ ...newThread, subject: event.target.value })} />
          </Field>
          <Field label="Message" htmlFor="mt-body" required>
            <Textarea id="mt-body" required value={newThread.body} onChange={(event) => setNewThread({ ...newThread, body: event.target.value })} />
          </Field>
          <Button type="submit" disabled={!newThread.patientId || !newThread.subject || !newThread.body}>
            Start conversation
          </Button>
        </form>
      </Modal>
    </div>
  );
}
