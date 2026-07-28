import type { Room } from './Room';

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  MODELS: R2Bucket;
  ASSETS: Fetcher;
}
