import { BotView } from '@/components/bots/BotView';

export default async function Page({ params }: { params: Promise<{ botId: string }> }) {
  const { botId } = await params;
  return <BotView botId={botId} />;
}
