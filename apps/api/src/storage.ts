import type { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import { config } from './config.js';

export const minioClient = new MinioClient({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
});

// Chamado uma vez no boot (ver index.ts). Retry com backoff porque o
// container do MinIO pode ainda não estar de pé quando a API sobe — sem
// healthcheck cruzado no compose (a imagem oficial não traz utilitário HTTP
// pra checar), então a própria API tolera a espera em vez de depender do
// Docker pra isso. Falha aqui não derruba o processo: anexos ficam
// indisponíveis (erro 503 por requisição), mas o resto do app continua
// funcionando normalmente, mesmo padrão de resiliência já usado pro LiveKit.
export async function ensureAttachmentsBucket(): Promise<void> {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const exists = await minioClient.bucketExists(config.MINIO_BUCKET);
      if (!exists) await minioClient.makeBucket(config.MINIO_BUCKET);
      console.log(`Bucket de anexos "${config.MINIO_BUCKET}" pronto.`);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        console.error('Não foi possível preparar o storage de anexos (MinIO indisponível):', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

export async function uploadAttachmentObject(objectKey: string, buffer: Buffer, contentType: string): Promise<void> {
  await minioClient.putObject(config.MINIO_BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': contentType,
  });
}

export async function getAttachmentObjectStream(objectKey: string): Promise<Readable> {
  return minioClient.getObject(config.MINIO_BUCKET, objectKey);
}

export async function deleteAttachmentObject(objectKey: string): Promise<void> {
  await minioClient.removeObject(config.MINIO_BUCKET, objectKey);
}
