import '@mantine/core/styles.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';
import { Providers } from './providers';

export const metadata = { title: '海上搜救联合指挥', description: '联合搜救任务与资产协同原型' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><Providers>{children}</Providers></body></html>;
}
