import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { age, timeOnly } from '../lib/format';
import { useDepartments } from '../lib/hooks';
import { Badge, Button, Card, CardHeader, EmptyState, Loading, PageHeader, Select, StatusBadge, Table, useToast } from '../components/ui';

export function useQueueStream(departmentId: string | undefined) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!departmentId) return;
    const source = new EventSource(`/api/v1/queue/stream?departmentId=${encodeURIComponent(departmentId)}`);
    source.addEventListener('ready', () => setConnected(true));
    source.addEventListener('queue', (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      queryClient.setQueryData(['queue', departmentId], data);
    });
    source.onerror = () => setConnected(false);
    return () => {
      source.close();
      setConnected(false);
    };
  }, [departmentId, queryClient]);

  return connected;
}

export default function Queue() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const departments = useDepartments();
  const [departmentId, setDepartmentId] = useState('');
  const clinical = (departments.data?.data ?? []).filter((d) => d.type === 'CLINICAL');

  useEffect(() => {
    if (!departmentId && clinical.length) setDepartmentId(clinical[0].id);
  }, [clinical, departmentId]);

  const connected = useQueueStream(departmentId);
  const snapshot = useQuery({
    queryKey: ['queue', departmentId],
    queryFn: () => api.get<any>('/queue', { departmentId }),
    enabled: Boolean(departmentId),
  });

  async function action(id: string, verb: 'call' | 'start' | 'complete' | 'skip') {
    try {
      await api.post(`/queue/${id}/${verb}`);
      toast.push(`Patient ${verb === 'start' ? 'sent in' : verb + 'ed'}`, 'success');
      queryClient.invalidateQueries({ queryKey: ['queue', departmentId] });
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Could not update the queue', 'danger');
    }
  }

  const data = snapshot.data;

  return (
    <div>
      <PageHeader
        title="Live queue"
        description="Triage priority first, then arrival time. Updates stream in real time."
        actions={
          <>
            <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Clinic">
              {clinical.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
            <Link to={`/board?departmentId=${departmentId}`}>
              <Button variant="outline">Waiting board</Button>
            </Link>
          </>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <Badge tone={connected ? 'success' : 'neutral'}>{connected ? 'Live' : 'Polling'}</Badge>
        <span>Average consultation: {data?.avgConsultMinutes ?? '—'} min</span>
        {data?.inProgress?.length > 0 && <span>{data.inProgress.length} in progress</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Waiting" subtitle="Ordered by priority then check-in time" />
          {snapshot.isLoading ? (
            <Loading />
          ) : (data?.waiting ?? []).length === 0 ? (
            <EmptyState title="Queue is clear" description="Nobody is waiting in this clinic." />
          ) : (
            <Table head={['#', 'Ticket', 'Patient', 'Priority', 'Waiting', 'Est. wait', '']}>
              {data.waiting.map((entry: any) => (
                <tr key={entry.id}>
                  <td className="table-cell font-semibold text-slate-500">{entry.position}</td>
                  <td className="table-cell font-mono font-medium">{entry.ticketNo}</td>
                  <td className="table-cell">
                    <p className="font-medium text-slate-800">
                      {entry.patient.firstName} {entry.patient.lastName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {entry.patient.mrn} · {age(entry.patient.dateOfBirth)} yrs
                    </p>
                  </td>
                  <td className="table-cell">
                    <StatusBadge status={entry.priority} />
                  </td>
                  <td className="table-cell text-xs">{timeOnly(entry.checkedInAt)}</td>
                  <td className="table-cell">{entry.estimatedWaitMinutes} min</td>
                  <td className="table-cell">
                    {can('queue.write') && (
                      <div className="flex gap-1">
                        <Button size="sm" onClick={() => action(entry.id, 'call')}>
                          Call
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => action(entry.id, 'skip')}>
                          Skip
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader title="In progress" />
          {(data?.inProgress ?? []).length === 0 ? (
            <EmptyState title="Nobody in the room" />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.inProgress.map((entry: any) => (
                <li key={entry.id} className="px-4 py-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-800">
                        {entry.patient.firstName} {entry.patient.lastName}
                      </p>
                      <p className="text-xs text-slate-500">
                        {entry.ticketNo} · {entry.doctor ? `Dr ${entry.doctor.lastName}` : 'Unassigned'}
                      </p>
                    </div>
                    <StatusBadge status={entry.status} />
                  </div>
                  {can('queue.write') && (
                    <div className="mt-2 flex gap-1.5">
                      {entry.status === 'CALLED' && (
                        <Button size="sm" onClick={() => action(entry.id, 'start')}>
                          Start consult
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => action(entry.id, 'complete')}>
                        Complete
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
