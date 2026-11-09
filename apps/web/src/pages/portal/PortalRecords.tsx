import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { dateOnly, dateTime } from '../../lib/format';
import { Badge, Card, CardHeader, EmptyState, Loading, PageHeader, StatusBadge, Table, Tabs } from '../../components/ui';

export default function PortalRecords() {
  const [tab, setTab] = useState('results');

  const prescriptions = useQuery({
    queryKey: ['portal-prescriptions'],
    queryFn: () => api.get<{ data: any[] }>('/portal/prescriptions'),
    enabled: tab === 'prescriptions',
  });
  const results = useQuery({
    queryKey: ['portal-results'],
    queryFn: () => api.get<{ data: any[] }>('/me/lab-results'),
    enabled: tab === 'results',
  });
  const patients = useQuery({
    queryKey: ['portal-patients'],
    queryFn: () => api.get<{ data: any[] }>('/portal/patients'),
  });

  return (
    <div>
      <PageHeader title="Health records" description="Lab results and prescriptions shared with you. Clinical notes are available from your doctor on request." />

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'results', label: 'Lab results' },
          { id: 'prescriptions', label: 'Prescriptions' },
          { id: 'profile', label: 'My details' },
        ]}
      />

      <div className="mt-3">
        {tab === 'results' && (
          <Card>
            <CardHeader title="Laboratory results" subtitle="Only released results are shown" />
            {results.isLoading ? (
              <Loading />
            ) : (results.data?.data ?? []).length === 0 ? (
              <EmptyState title="No results available" description="Results appear here once the laboratory has released them." />
            ) : (
              <Table head={['Test', 'Released', 'Result', 'Reference', 'Flag']}>
                {results.data!.data.map((row) => (
                  <tr key={row.id}>
                    <td className="table-cell font-medium">{row.test}</td>
                    <td className="table-cell text-xs">{dateOnly(row.completedAt)}</td>
                    <td className="table-cell">
                      {row.result?.value} {row.result?.unit ?? ''}
                    </td>
                    <td className="table-cell text-xs text-slate-500">{row.result?.referenceRange ?? '—'}</td>
                    <td className="table-cell">
                      <StatusBadge status={row.result?.flag ?? 'NORMAL'} />
                    </td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        )}

        {tab === 'prescriptions' && (
          <Card>
            <CardHeader title="Prescriptions" subtitle="What your doctor prescribed and whether it was dispensed" />
            {prescriptions.isLoading ? (
              <Loading />
            ) : (prescriptions.data?.data ?? []).length === 0 ? (
              <EmptyState title="No prescriptions" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {prescriptions.data!.data.map((script) => (
                  <li key={script.id} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">
                        {dateTime(script.createdAt)} · Dr {script.doctor.firstName} {script.doctor.lastName}
                      </p>
                      <StatusBadge status={script.status} />
                    </div>
                    <ul className="mt-1 space-y-0.5 text-xs text-slate-600">
                      {script.items.map((item: any) => (
                        <li key={item.id}>
                          {item.drug.name} {item.drug.strength} — {item.dose}, {item.frequency}, {item.durationDays} days
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {tab === 'profile' && (
          <Card>
            <CardHeader title="Your details" subtitle="Ask reception or medical records to correct anything that is wrong" />
            {patients.isLoading ? (
              <Loading />
            ) : (patients.data?.data ?? []).length === 0 ? (
              <EmptyState title="No linked records" />
            ) : (
              <ul className="divide-y divide-slate-100">
                {patients.data!.data.map((patient) => (
                  <li key={patient.id} className="px-4 py-3">
                    <p className="text-sm font-medium">
                      {patient.firstName} {patient.lastName} <span className="font-mono text-xs text-slate-500">{patient.mrn}</span>
                    </p>
                    <p className="text-xs text-slate-500">
                      {dateOnly(patient.dateOfBirth)} · {patient.sex.toLowerCase()} · {patient.relationship}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-1">
                      {patient.scopes.map((scope: string) => (
                        <Badge key={scope} tone="brand">
                          {scope}
                        </Badge>
                      ))}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
