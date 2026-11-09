import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useDepartments } from '../lib/hooks';
import { dateOnly } from '../lib/format';
import { useQueueStream } from './Queue';
import { EmptyState, Loading, Select } from '../components/ui';

/**
 * Waiting-area display board. Deliberately privacy-preserving: ticket numbers
 * and wait estimates only, never patient names or clinical detail.
 */
export default function QueueBoard() {
  const [params] = useSearchParams();
  const [departmentId, setDepartmentId] = useState(params.get('departmentId') ?? '');
  const [now, setNow] = useState(new Date());
  const departments = useDepartments();
  const clinical = (departments.data?.data ?? []).filter((d) => d.type === 'CLINICAL');

  useEffect(() => {
    if (!departmentId && clinical.length) setDepartmentId(clinical[0].id);
  }, [clinical, departmentId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useQueueStream(departmentId);

  const board = useQuery({
    queryKey: ['board', departmentId],
    queryFn: () => api.get<any>('/queue/board', { departmentId }),
    enabled: Boolean(departmentId),
    refetchInterval: 20_000,
  });

  const data = board.data;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Waiting board</h1>
          <p className="text-sm text-slate-500">Show this on the screen in the waiting area. No patient names are displayed.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Clinic">
            {clinical.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
          <Link to={`/queue?departmentId=${departmentId}`} className="text-sm font-medium text-brand-700 hover:underline">
            Manage queue
          </Link>
        </div>
      </div>

      {board.isLoading ? (
        <Loading />
      ) : (
        <div className="rounded-2xl bg-brand-950 p-6 text-white shadow-xl sm:p-10">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-white/10 pb-4">
            <div>
              <p className="text-2xl font-semibold">{data?.department ?? 'Clinic'}</p>
              <p className="text-sm text-brand-300">{dateOnly(now)} · updates automatically</p>
            </div>
            <p className="text-4xl font-semibold tabular-nums">{now.toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })}</p>
          </div>

          <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1.2fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-brand-300">Now serving</p>
              {(data?.nowServing ?? []).length === 0 ? (
                <p className="mt-3 text-xl text-brand-200">Please wait to be called.</p>
              ) : (
                <ul className="mt-3 space-y-3">
                  {data.nowServing.map((entry: any) => (
                    <li key={entry.ticketNo} className="rounded-xl bg-white/10 px-5 py-4">
                      <p className="text-4xl font-bold tabular-nums tracking-wide">{entry.ticketNo}</p>
                      <p className="text-sm text-brand-200">{entry.doctor}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-6 text-xs text-brand-400">Average consultation: {data?.averageConsultMinutes ?? 15} minutes</p>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-brand-300">Waiting</p>
              {(data?.waiting ?? []).length === 0 ? (
                <EmptyState title="Nobody waiting" description="The queue is empty." />
              ) : (
                <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {data.waiting.map((entry: any) => (
                    <li key={entry.ticketNo} className="rounded-lg bg-white/5 px-3 py-2.5">
                      <p className="text-xl font-semibold tabular-nums">{entry.ticketNo}</p>
                      <p className="text-xs text-brand-300">
                        {entry.priority !== 'NORMAL' && <span className="mr-1 rounded bg-amber-400/20 px-1 text-amber-200">{entry.priority}</span>}
                        ~{entry.estimatedWaitMinutes} min
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
