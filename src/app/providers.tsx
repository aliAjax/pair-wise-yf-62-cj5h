'use client';

import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <NextIntlClientProvider locale="zh" messages={{
      title: '海上搜救联合指挥',
      subtitle: '搜索区、力量与任务在同一时间线上协同'
    }}>
      <MantineProvider defaultColorScheme="light">
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </MantineProvider>
    </NextIntlClientProvider>
  );
}
