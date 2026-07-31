/*
  Warnings:

  - You are about to drop the column `updated_at` on the `settings` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `settings` table without a default value. This is not possible if the table is not empty.
  - Made the column `encrypted` on table `settings` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "settings" DROP COLUMN "updated_at",
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "key" SET DATA TYPE TEXT,
ALTER COLUMN "encrypted" SET NOT NULL;

-- CreateTable
CREATE TABLE "xui_connections" (
    "id" BIGSERIAL NOT NULL,
    "panelUrl" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordEncrypted" TEXT NOT NULL,
    "cookie" TEXT,
    "lastLogin" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "xui_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_clients" (
    "id" BIGSERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "telegramId" TEXT,
    "uuid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "xuiInboundId" BIGINT NOT NULL,
    "expireAt" TIMESTAMP(3),
    "trafficLimit" BIGINT NOT NULL,
    "trafficUsed" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vpn_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "xui_connections_panelUrl_key" ON "xui_connections"("panelUrl");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_clients_uuid_key" ON "vpn_clients"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_clients_email_key" ON "vpn_clients"("email");

-- RenameIndex
ALTER INDEX "idx_settings_key" RENAME TO "settings_key_idx";
