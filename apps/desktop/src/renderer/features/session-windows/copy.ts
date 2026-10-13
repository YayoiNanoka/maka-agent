/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { UiLocale } from '@maka/core/ui-locale';
const COPY = {
  'zh-CN': { failed: '无法打开任务窗口', deleted: '会话已删除', opening: '正在打开任务…' },
  'zh-TW': { failed: '無法開啟任務視窗', deleted: '會話已刪除', opening: '正在開啟任務…' },
  en: { failed: 'Could not open task window', deleted: 'This conversation was deleted', opening: 'Opening task…' },
};
export function sessionWindowCopy(locale: UiLocale) { return COPY[locale]; }
