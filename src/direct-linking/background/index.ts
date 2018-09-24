import { browser } from 'webextension-polyfill-ts'

import {
    makeRemotelyCallable,
    remoteFunction,
} from '../../util/webextensionRPC'
import DirectLinkingBackend from './backend'
import { setupRequestInterceptor } from './redirect'
import { AnnotationRequests } from './request'
import DirectLinkingStorage, { AnnotationStorage } from './storage'
import normalize from '../../util/encode-url-for-id'
import { StorageManager } from '../../search/types'
import { AnnotationSender } from '../types'

export default class DirectLinkingBackground {
    private backend: DirectLinkingBackend
    private sendAnnotation: AnnotationSender
    private requests: AnnotationRequests
    directLinkingStorage: DirectLinkingStorage
    annotationStorage: AnnotationStorage

    constructor({ storageManager }: { storageManager: StorageManager }) {
        this.backend = new DirectLinkingBackend()
        this.directLinkingStorage = new DirectLinkingStorage({ storageManager })
        this.annotationStorage = new AnnotationStorage({ storageManager })
        this.sendAnnotation = ({ tabId, annotation }) => {
            browser.tabs.sendMessage(tabId, { type: 'direct-link', annotation })
        }
        this.requests = new AnnotationRequests(
            this.backend,
            this.sendAnnotation,
        )
    }

    setupRemoteFunctions() {
        makeRemotelyCallable(
            {
                createDirectLink: this.createDirectLink.bind(this),
                getAllAnnotations: this.getAllAnnotationsByUrl.bind(this),
                createAnnotation: this.createAnnotation.bind(this),
                editAnnotation: this.editAnnotation.bind(this),
                deleteAnnotation: this.deleteAnnotation.bind(this),
                toggleSidebar: this.toggleSidebar.bind(this),
                getAnnotationTags: this.getTagsByAnnotationUrl.bind(this),
                addAnnotationTag: this.addTagForAnnotation.bind(this),
                delAnnotationTag: this.delTagForAnnotation.bind(this),
                followAnnotationRequest: this.followAnnotationRequest.bind(
                    this,
                ),
                openSidebarWithHighlight: this.openSidebarWithHighlight.bind(
                    this,
                ),
            },
            { insertExtraArg: true },
        )
    }

    setupRequestInterceptor() {
        setupRequestInterceptor({
            requests: this.requests,
            webRequest: browser.webRequest,
        })
    }

    async triggerSidebar(functionName, ...args) {
        const [currentTab] = await browser.tabs.query({
            active: true,
            currentWindow: true,
        })
        await remoteFunction(functionName, { tabId: currentTab.id })(...args)
    }

    async toggleSidebar() {
        await this.triggerSidebar('toggleSidebarOverlay')
    }

    async openSidebarWithHighlight({ tab }, anchor) {
        this.triggerSidebar('openSidebarAndSendAnchor', anchor)
    }

    followAnnotationRequest({ tab }) {
        this.requests.followAnnotationRequest(tab.id)
    }

    async createDirectLink({ tab }, request) {
        const pageTitle = tab.title
        const result = await this.backend.createDirectLink(request)
        await this.annotationStorage.insertDirectLink({
            pageTitle,
            pageUrl: tab.url,
            body: request.anchor.quote,
            url: result.url,
            selector: request.anchor,
        })

        // Attempt to (re-)index, if user preference set, but don't wait for it
        this.annotationStorage.indexPageFromTab(tab)

        return result
    }

    async getAllAnnotationsByUrl({ tab }, url) {
        let pageUrl = url === null ? tab.url : url
        pageUrl = normalize(pageUrl)
        const annotations = await this.annotationStorage.getAnnotationsByUrl(
            pageUrl,
        )
        return annotations.map(
            ({ createdWhen, lastEdited, ...annotation }) => ({
                ...annotation,
                createdWhen: createdWhen.getTime(),
                lastEdited: lastEdited.getTime ? lastEdited.getTime() : null,
            }),
        )
    }

    async createAnnotation({ tab }, { url, title, comment, body, selector }) {
        const pageUrl = url === null ? tab.url : url
        const pageTitle = title === null ? tab.title : title
        const uniqueUrl = `${pageUrl}/#${Date.now()}`

        await this.annotationStorage.createAnnotation({
            url: uniqueUrl,
            pageTitle,
            selector,
            pageUrl,
            comment,
            body,
        })

        return uniqueUrl
    }

    async editAnnotation({ tab }, pk, comment) {
        return this.annotationStorage.editAnnotation(pk, comment)
    }

    async deleteAnnotation({ tab }, pk) {
        return this.annotationStorage.deleteAnnotation(pk)
    }

    async getTagsByAnnotationUrl({ tab }, url) {
        return this.annotationStorage.getTagsByAnnotationUrl(url)
    }

    async addTagForAnnotation({ tab }, { tag, url }) {
        return this.annotationStorage.modifyTags(true)(tag, url)
    }

    async delTagForAnnotation({ tab }, { tag, url }) {
        return this.annotationStorage.modifyTags(false)(tag, url)
    }
}
