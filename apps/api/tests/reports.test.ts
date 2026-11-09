import { describe, expect, it } from 'vitest';
import { signIn } from './helpers';

describe('dashboards and reports', () => {
  it('returns real management metrics for HR', async () => {
    const hr = await signIn('hr@medisync.test');
    const res = await hr.get('/api/v1/reports/overview').expect(200);
    expect(res.body.patients.new).toBeGreaterThan(0);
    expect(res.body.appointments.total).toBeGreaterThan(0);
    expect(res.body.revenue.collected).toBeGreaterThan(0);
    expect(res.body.queue.avgWaitMinutes).toBeGreaterThan(0);
    expect(res.body.stock.lowStock).toBeGreaterThan(0);
    // Aggregates only: no patient identifiers may leak into reports.
    expect(JSON.stringify(res.body)).not.toContain('Grace');
  });

  it('breaks wait times down by department', async () => {
    const hr = await signIn('hr@medisync.test');
    const res = await hr.get('/api/v1/reports/wait-times').expect(200);
    const general = res.body.data.find((d: any) => d.department === 'General Medicine');
    expect(general).toBeTruthy();
    expect(general.completed).toBeGreaterThan(0);
    expect(general.avgWaitMinutes).toBeGreaterThan(0);
  });

  it('restricts financial reports to finance roles', async () => {
    const hr = await signIn('hr@medisync.test');
    expect((await hr.get('/api/v1/reports/revenue')).status).toBe(403);

    const billing = await signIn('billing@medisync.test');
    const revenue = await billing.get('/api/v1/reports/revenue').expect(200);
    expect(revenue.body.totals.collected).toBeGreaterThan(0);
    expect(revenue.body.byMethod.length).toBeGreaterThan(0);
  });

  it('exports CSV and PDF reports', async () => {
    const hr = await signIn('hr@medisync.test');
    const csv = await hr.get('/api/v1/reports/export?type=overview&format=csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('New patients');

    const pdf = await hr.get('/api/v1/reports/export?type=wait-times&format=pdf').expect(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.body.length).toBeGreaterThan(800);
  });

  it('shows stock alerts from live inventory', async () => {
    const pharmacist = await signIn('pharmacist@medisync.test');
    const res = await pharmacist.get('/api/v1/stock/alerts').expect(200);
    expect(res.body.lowStock.length).toBeGreaterThan(0);
    expect(res.body.expiringSoon.length).toBeGreaterThan(0);
    expect(res.body.counts.lowStock).toBe(res.body.lowStock.length);
  });

  it('lets the auditor read aggregated reports but not clinical detail', async () => {
    const auditor = await signIn('auditor@medisync.test');
    expect((await auditor.get('/api/v1/reports/overview')).status).toBe(200);
    expect((await auditor.get('/api/v1/encounters')).status).toBe(403);
  });
});
