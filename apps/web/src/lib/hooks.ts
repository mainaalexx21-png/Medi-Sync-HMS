import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Department {
  id: string;
  name: string;
  code: string;
  type: string;
}

export interface Doctor {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string;
  departmentId: string | null;
  department?: { name: string } | null;
}

export function useDepartments() {
  return useQuery({
    queryKey: ['departments'],
    queryFn: () => api.get<{ data: Department[] }>('/departments'),
    staleTime: 5 * 60_000,
  });
}

export function useDoctors(departmentId?: string) {
  return useQuery({
    queryKey: ['doctors', departmentId ?? 'all'],
    queryFn: () => api.get<{ data: Doctor[] }>('/doctors', { departmentId }),
    staleTime: 5 * 60_000,
  });
}

export function useDrugs(search = '') {
  return useQuery({
    queryKey: ['drugs', search],
    queryFn: () => api.get<{ data: any[] }>('/drugs', { search, pageSize: 200 }),
    staleTime: 60_000,
  });
}

export function useLabTests() {
  return useQuery({
    queryKey: ['lab-tests'],
    queryFn: () => api.get<{ data: any[] }>('/lab-tests'),
    staleTime: 5 * 60_000,
  });
}

export function usePatients(search = '') {
  return useQuery({
    queryKey: ['patients', search],
    queryFn: () => api.get<{ data: any[]; pagination: any }>('/patients', { search, pageSize: 100 }),
  });
}
