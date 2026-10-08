export function scheduleDestination(task) {
    return task.destination ?? { version: 1, platform: "discord", tenantId: task.guildId, channelId: task.channelId, kind: "channel" };
}
export function schedulePlatform(task) {
    return scheduleDestination(task).platform;
}
export function scheduleOwnerKey(task) {
    const d = scheduleDestination(task);
    return JSON.stringify([d.platform, d.tenantId, task.ownerId]);
}
export function scheduleTenantKey(task) {
    const d = scheduleDestination(task);
    return JSON.stringify([d.platform, d.tenantId]);
}
