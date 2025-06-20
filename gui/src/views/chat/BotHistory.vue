<script setup>
import { ref, onMounted,onBeforeUnmount, onActivated, watch, computed } from "vue";
import { useStore } from 'vuex';
import { getItem, setItem, pushItem, deleteItem,STORE_BOT_REPLAY } from "@/utils/localStore";
import confirm from "@/utils/confirm";
import { getKeywordIcon } from '@/utils/file';
import { dayjs, extend } from '@/utils/dayjs';
import BotService from '@/service/BotService';
import { useI18n } from 'vue-i18n';
const { t, locale } = useI18n();
extend(locale.value)
const store = useStore();
const props = defineProps(['room']);
const emits = defineEmits(['back','ep','clear','update:room']);
const windowWidth = ref(window.innerWidth);
const isMobile = computed(() => windowWidth.value<=768);
const windowHeight = ref(window.innerHeight);
const viewHeight = computed(() => windowHeight.value - (isMobile.value?43:30));
const today = ref(new Date());
const replays = ref([]);

const botService = new BotService();
const loading = ref(false);
const saving = ref(false);
const selectedMesh = computed(() => {
	return store.getters["account/selectedMesh"]
});

const back = () => {
	emits('back')
}
const timeago = computed(() => (ts) => {
	const date = new Date(ts);
	return dayjs(date).fromNow();
})

const loaddata = () => {
	getItem(STORE_BOT_REPLAY(selectedMesh.value?.name,props?.room?.id),(res)=>{
		replays.value = res || {};
		replays.value.forEach((r)=>{
			r.loading = false;
		})
	});
}
const clear = () => {
	confirm.custom({
		message: `Are you sure to clear this history?`,
		header: 'Tip',
		icon: 'pi pi-info-circle',
		accept: () => {
			setItem(STORE_BOT_REPLAY(selectedMesh.value?.name,props?.room?.id),[],(res)=>{
				loaddata();
			});
			setItem(STORE_BOT_HISTORY(selectedMesh.value?.name,props?.room?.id),[],(res)=>{
				emits('clear')
			});
		},
		reject: () => {
		}
	});
}
const delReplay = (index) => {
	deleteItem(STORE_BOT_REPLAY(selectedMesh.value?.name,props?.room?.id),index,()=>{
		loaddata();
	})
}
const makeReplay = (index) => {
	if(!replays.value[index].loading){
		replays.value[index].loading = true;
		replays.value[index].toolcalls.forEach((t)=>{
			t.data=null;
		})
		botService.replayToolcalls(replays.value[index].toolcalls||[]).then((resp)=>{
			setTimeout(()=>{
				replays.value[index].loading = false;
				replays.value[index].toolcalls = resp;
			},1000);
		})
	} else {
		loaddata();
		replays.value[index].loading = false;
	}
}
const args = computed(() => (tc) => {
	try{
		return JSON.parse(tc.tool_call[tc.tool_call?.type]?.arguments);
	}catch(e){
		return {}
	}
})
const args_key = computed(() => (tc) => {
	try{
		return Object.keys(JSON.parse(tc.tool_call[tc.tool_call?.type]?.arguments));
	}catch(e){
		return []
	}
})
onMounted(()=>{
	loaddata();
})
defineExpose({
	loaddata
})
</script>
<template>
	
	<AppHeader :back="back" >
	    <template #center>
	      <b>{{t('Replay')}}</b>
	    </template>
	    <template #end> 
				<Button v-tooltip="t('Clear History')" :loading="loading" icon="pi pi-trash"  severity="danger" text  @click="clear"/>
			</template>
	</AppHeader>
	<VirtualScroller :delay="50" v-if="replays&&replays.length>0" :items="replays" :itemSize="50" class="border border-surface-200 dark:border-surface-700 w-full" :style="`height:${viewHeight}px`">
		<template v-slot:item="{ item, options }">
			<Card class="m-3">
				<template #content>
					<Fieldset :collapsed="true" :toggleable="true">
						<template #legend="{ toggleCallback }">
							<div class="text-sm p-3 flex pointer"  @click="toggleCallback">
								<div><i class="pi pi-code relative mr-2 text-primary" style="top:2px;"/> {{item.message}}</div>
								<i class="pi pi-angle-double-down relative" style="top:2px;"/>
							</div>
						</template>
						<ul class="px-4" style="list-style: none;">
							<li class="mb-2" v-for="(tc,idx) in item.toolcalls" :key="idx">
								<div v-if="tc?.tool_call">
									<Fieldset class="innerset" :collapsed="true" :toggleable="true">
											<template #legend="{ toggleCallback }">
												<div class="flex items-center p-2 pointer" @click="toggleCallback">
													<div>
														<Badge style="padding:0 !important" size="small"  :value="tc.tool_call?.index+1"/>
													</div>
													<div class="flex-item relative pl-2" style="top:-2px">
														<img :src="getKeywordIcon(tc.tool_call[tc.tool_call?.type]?.name.split('___')[1], 'mcp')" width="20px" height="20px" class="relative mr-1" style="top:4px"/>
														<b class="pr-2 " >{{tc.tool_call[tc.tool_call?.type]?.name.split('___')[0]}} ( {{args_key(tc).length}} {{t('Args')}} )</b>
													</div>
													<i class="pi pi-angle-down relative" style="top:4px;right:5px"/>
												</div>
											</template>
											<p class="mt-2 mx-0 mb-0 argList">
												<div class="pl-2 m-1" :key="pi" v-for="(pk,pi) in args_key(tc)">
													<span>{{pk}}</span> : <TagInput v-if="tc.tool_call[tc.tool_call?.type]?.arguments" v-model:obj="tc.tool_call[tc.tool_call.type]" :k="pk"/>
												</div>
											</p>
									</Fieldset>
								</div>
								<div class="mt-2 mb-4" v-if="tc?.data">
									<Message v-tooltip="msg?.text" style="word-break: break-all;" v-for="(msg) in tc?.data?.content||[]" severity="success" icon="pi pi-check">
										{{msg?.text.length>150?(msg?.text?.substr(0,150)+'...'):msg?.text}}
									</Message>
								</div>
								<ProgressBar v-else mode="indeterminate" style="height: 6px"></ProgressBar>
							
							</li>
						</ul>
					
					</Fieldset>
				</template>
				<template #footer>
						<InputGroup>
							<Button class="w-2" @click="loaddata" icon="pi pi-replay" severity="secondary"/>
							<Button :severity="item.loading?'danger':'secondary'" class="w-full" @click="makeReplay(options?.index)" >
								<i :class="item.loading?'pi pi-stop-circle':'pi pi-caret-right'"/>
								<span v-if="item.loading">{{t('Stop')}}</span>
								<span v-else-if="!!item?.date">{{timeago(item.date)}} {{t('Replay')}}</span>
								<span v-else>{{t('Replay')}}</span>
							</Button>
							<Button class="w-2" @click="delReplay(options?.index)" icon="pi pi-times" severity="secondary"/>
						</InputGroup>
				</template>
			</Card>
		</template>
	</VirtualScroller>
	<div class="p-4 text-center opacity-60" v-else>
		<i class="pi pi-box mr-2"/>{{t('No Message.')}}
	</div>
</template>

<style lang="scss" scoped>
	:deep(th.p-datepicker-weekday-cell){
		text-align: center !important;
	}
	:deep(.p-fieldset){
		padding:0;
		// background-color: var(--surface-subground);
		border-width: 0;
	}
	:deep(.p-fieldset-legend){
		border-radius: 0;
		width: 100%;
		margin: 0 !important;
	}
	.innerset :deep(.p-fieldset-legend){
		background-color: var(--surface-subground);
	}
	:deep(.p-card-body){
		gap:0 !important;
	}
	.argList{
		border-style: none dashed none dashed;
		border-color: var(--surface-border);
	}
	:deep(.p-inputgroup){
		border-radius: 0 0 10px 10px;
		overflow: hidden;
	}
	:deep(.p-inputgroup .p-button){
		height:42px;
	}
</style>