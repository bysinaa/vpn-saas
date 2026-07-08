# Bug Fixes Summary

## Issues Fixed

### 1. Admin Panel Receipt Issue ✅
**Problem**: Admins were not receiving receipt photos when users uploaded card-to-card payment receipts.

**Root Cause**: The receipt sending logic was trying to access `ctx.telegram.sendPhoto()` directly, but the context object didn't have access to the telegram instance properly.

**Solution**: 
- Added `sendPhoto()` method to `BotRuntime` class that queues photo messages
- Created `TelegramNotificationsProcessor` to handle queued photo messages
- Updated `BuyFlow.onReceiptUpload()` to use the new queue-based photo sending method

**Files Modified**:
- `src/modules/telegram/bot-runtime.ts` - Added `sendPhoto()` method
- `src/modules/telegram/flows/buy.flow.ts` - Updated receipt upload handler
- `src/modules/telegram/notifications.processor.ts` - Created new processor
- `src/modules/telegram/telegram.module.ts` - Registered new processor

### 2. Broadcasting Error ✅
**Problem**: Broadcasting was failing with error due to bot initialization issues.

**Root Cause**: The bot was being initialized in `onModuleInit()` before the proxy was ready.

**Solution**: 
- Implemented lazy bot initialization with `ensureBot()` method
- Changed bot initialization to happen when needed rather than at module startup

**Files Modified**:
- `src/modules/notifications/broadcast.service.ts` - Added lazy initialization

### 3. Admin Menu Restriction ✅
**Problem**: Admin users were seeing both admin panel button AND regular user menu buttons.

**Root Cause**: The `mainMenuKeyboard()` function was adding admin button to the regular user keyboard.

**Solution**: 
- Completely separated admin and user keyboards
- Admin users now see ONLY the "Admin Panel" button
- Regular users see only user-specific options

**Files Modified**:
- `src/modules/telegram/keyboards.ts` - Separated admin and user menu keyboards

### 4. Duplicate Buttons Issue ✅
**Problem**: Users were seeing both inline keyboard buttons and reply keyboard buttons, causing duplication.

**Root Cause**: Messages were being sent without removing existing reply keyboards first.

**Solution**: 
- Updated `BotRuntime.send()` method to always remove reply keyboards
- Ensures only inline keyboards are shown to users

**Files Modified**:
- `src/modules/telegram/bot-runtime.ts` - Added keyboard cleanup logic

## Technical Details

### New Components

#### TelegramNotificationsProcessor
- Handles all queued Telegram messages
- Supports both text and photo messages
- Uses same proxy configuration as main bot
- Processes jobs from the NOTIFICATIONS queue

### Method Changes

#### BotRuntime.sendPhoto()
```typescript
async sendPhoto(chatId: string, fileId: string, caption?: string): Promise<void>
```
- Queues photo messages for admins
- Used for receipt notifications

#### mainMenuKeyboard() - New Logic
```typescript
export function mainMenuKeyboard(locale: BotLocale, role?: string | null)
```
- Returns different keyboards based on user role
- Admins: Only admin panel button
- Users: Only user menu options

#### send() - Keyboard Cleanup
- Removes reply keyboards before sending new messages
- Prevents duplicate buttons

## Testing Recommendations

1. **Test Receipt Uploads**:
   - Use a test account to make a purchase
   - Select card-to-card payment
   - Upload a receipt photo
   - Verify admin receives the photo with caption

2. **Test Broadcasting**:
   - Create a broadcast message
   - Select target audience (ALL/USER/ADMIN)
   - Monitor broadcast status
   - Verify messages are sent successfully

3. **Test Menu Separation**:
   - Login as admin account
   - Verify only "Admin Panel" button appears
   - Login as regular user
   - Verify only user menu buttons appear

4. **Test Button Cleanup**:
   - Navigate through various bot flows
   - Ensure no duplicate buttons appear
   - Verify only inline keyboards are shown

## Configuration Requirements

Ensure the following environment variables are set:
- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `TELEGRAM_ADMIN_IDS` - Comma-separated list of admin Telegram IDs
- Proxy settings if applicable

## Rollback Plan

If issues occur, the following commits/files can be reverted:
- `src/modules/telegram/notifications.processor.ts` - Remove this file
- `src/modules/telegram/telegram.module.ts` - Remove processor registration
- `src/modules/telegram/keyboards.ts` - Revert keyboard logic
- `src/modules/telegram/bot-runtime.ts` - Remove sendPhoto and keyboard cleanup
- `src/modules/notifications/broadcast.service.ts` - Revert initialization

## Performance Impact

- Minimal performance impact
- Queue-based messaging improves reliability
- Lazy initialization reduces startup time
- No additional database queries

## Security Considerations

- Admin photo notifications are sent via queue (more secure)
- User role validation happens before keyboard rendering
- No new security vulnerabilities introduced