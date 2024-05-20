import React, { useState, useEffect, useRef, useMemo, ReactNode } from 'react';

import type { BarcodeFormat } from 'barcode-detector';

import useCamera from '../hooks/useCamera';
import useScanner from '../hooks/useScanner';
import Finder from './Finder';

import { defaultComponents, defaultConstraints, defaultStyles } from '../misc';
import { IDetectedBarcode, IPoint, IScannerComponents, IScannerStyles, TrackFunction } from '../types';

export interface IScannerProps {
    onScan: (detectedCodes: IDetectedBarcode[]) => void;
    constraints?: MediaTrackConstraints;
    formats?: BarcodeFormat[];
    paused?: boolean;
    torch?: boolean;
    children?: ReactNode;
    components?: IScannerComponents;
    styles?: IScannerStyles;
    allowMultiple?: boolean;
    scanDelay?: number;
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    if (canvas === null) {
        throw new Error('Canvas should always be defined when component is mounted.');
    }

    const ctx = canvas.getContext('2d');

    if (ctx === null) {
        throw new Error('Canvas 2D context should be non-null');
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function onFound(detectedCodes: IDetectedBarcode[], videoEl?: HTMLVideoElement | null, trackingEl?: HTMLCanvasElement | null, tracker?: TrackFunction) {
    const canvas = trackingEl;

    if (canvas === undefined || canvas === null) {
        throw new Error('onFound handler should only be called when component is mounted. Thus tracking canvas is always defined.');
    }

    const video = videoEl;

    if (video === undefined || video === null) {
        throw new Error('onFound handler should only be called when component is mounted. Thus video element is always defined.');
    }

    if (detectedCodes.length === 0 || tracker === undefined) {
        clearCanvas(canvas);
    } else {
        const displayWidth = video.offsetWidth;
        const displayHeight = video.offsetHeight;

        const resolutionWidth = video.videoWidth;
        const resolutionHeight = video.videoHeight;

        const largerRatio = Math.max(displayWidth / resolutionWidth, displayHeight / resolutionHeight);
        const uncutWidth = resolutionWidth * largerRatio;
        const uncutHeight = resolutionHeight * largerRatio;

        const xScalar = uncutWidth / resolutionWidth;
        const yScalar = uncutHeight / resolutionHeight;
        const xOffset = (displayWidth - uncutWidth) / 2;
        const yOffset = (displayHeight - uncutHeight) / 2;

        const scale = ({ x, y }: IPoint) => {
            return {
                x: Math.floor(x * xScalar),
                y: Math.floor(y * yScalar)
            };
        };

        const translate = ({ x, y }: IPoint) => {
            return {
                x: Math.floor(x + xOffset),
                y: Math.floor(y + yOffset)
            };
        };

        const adjustedCodes = detectedCodes.map((detectedCode) => {
            const { boundingBox, cornerPoints } = detectedCode;

            const { x, y } = translate(
                scale({
                    x: boundingBox.x,
                    y: boundingBox.y
                })
            );
            const { x: width, y: height } = scale({
                x: boundingBox.width,
                y: boundingBox.height
            });

            return {
                ...detectedCode,
                cornerPoints: cornerPoints.map((point) => translate(scale(point))),
                boundingBox: DOMRectReadOnly.fromRect({ x, y, width, height })
            };
        });

        canvas.width = video.offsetWidth;
        canvas.height = video.offsetHeight;

        const ctx = canvas.getContext('2d');

        if (ctx === null) {
            throw new Error('onFound handler should only be called when component is mounted. Thus tracking canvas 2D context is always defined.');
        }

        tracker(adjustedCodes, ctx);
    }
}

export function Scanner(props: IScannerProps) {
    const { onScan, constraints, formats = ['qr_code'], paused = false, torch = false, components, children, styles, allowMultiple, scanDelay } = props;

    const mergedConstraints = { ...defaultConstraints, ...constraints };

    const videoRef = useRef<HTMLVideoElement>(null);
    const pauseFrameRef = useRef<HTMLCanvasElement>(null);
    const trackingLayerRef = useRef<HTMLCanvasElement>(null);

    const [isMounted, setIsMounted] = useState(false);
    const [isCameraActive, setIsCameraActive] = useState(true);

    const [constraintsCached, setConstraintsCached] = useState(mergedConstraints);
    const [torchCached, setTorchCached] = useState(torch);

    const comps = { ...defaultComponents, ...components };

    const camera = useCamera();

    const { startScanning } = useScanner({
        videoElementRef: videoRef,
        onScan: onScan,
        onFound: (detectedCodes) => onFound(detectedCodes, videoRef.current, trackingLayerRef.current, comps.tracker),
        formats: formats,
        audio: comps.audio,
        allowMultiple: allowMultiple,
        retryDelay: comps.tracker === undefined ? 500 : 10,
        scanDelay: scanDelay
    });

    useEffect(() => {
        setIsMounted(true);

        return () => {
            setIsMounted(false);
        };
    }, []);

    useEffect(() => {
        if (JSON.stringify(mergedConstraints) !== JSON.stringify(constraintsCached)) {
            const newConstraints = mergedConstraints;

            if (constraints?.deviceId) {
                delete newConstraints.facingMode;
            }

            setConstraintsCached(newConstraints);
        }
    }, [constraints]);

    const cameraSettings = useMemo(() => {
        return {
            torch: torchCached,
            constraints: constraintsCached,
            shouldStream: isMounted && !paused
        };
    }, [torchCached, constraintsCached, isMounted, paused]);

    const onCameraChange = async () => {
        const videoEl = videoRef.current;

        if (videoEl === undefined || videoEl === null) {
            throw new Error('Video should be defined when component is mounted.');
        }

        const canvasEl = pauseFrameRef.current;

        if (canvasEl === undefined || canvasEl === null) {
            throw new Error('Canvas should be defined when component is mounted.');
        }

        const ctx = canvasEl.getContext('2d');

        if (ctx === undefined || ctx === null) {
            throw new Error('Canvas should be defined when component is mounted.');
        }

        if (cameraSettings.shouldStream) {
            await camera.stopCamera();

            setIsCameraActive(false);

            try {
                await camera.startCamera(videoEl, cameraSettings);

                if (videoEl) {
                    setIsCameraActive(true);
                } else {
                    await camera.stopCamera();
                }
            } catch (error) {
                console.error('error', error);
            }
        } else {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;

            ctx.drawImage(videoEl, 0, 0, videoEl.videoWidth, videoEl.videoHeight);

            await camera.stopCamera();

            setIsCameraActive(false);
        }
    };

    useEffect(() => {
        (async () => {
            await onCameraChange();
        })();
    }, [cameraSettings]);

    const shouldScan = useMemo(() => {
        return cameraSettings.shouldStream && isCameraActive;
    }, [cameraSettings.shouldStream, isCameraActive]);

    useEffect(() => {
        if (shouldScan) {
            if (pauseFrameRef.current === undefined) {
                throw new Error('shouldScan effect should only be triggered when component is mounted. Thus pause frame canvas is defined');
            }

            clearCanvas(pauseFrameRef.current);

            if (trackingLayerRef.current === undefined) {
                throw new Error('shouldScan effect should only be triggered when component is mounted. Thus tracking canvas is defined');
            }

            clearCanvas(trackingLayerRef.current);

            const videoEl = videoRef.current;

            if (videoEl === undefined || videoEl === null) {
                throw new Error('shouldScan effect should only be triggered when component is mounted. Thus video element is defined');
            }

            startScanning();
        }
    }, [shouldScan]);

    return (
        <div style={{ ...defaultStyles.container, ...styles?.container }}>
            <video ref={videoRef} style={{ ...defaultStyles.video, visibility: paused ? 'hidden' : 'visible' }} autoPlay muted playsInline />
            <canvas ref={pauseFrameRef} style={{ display: paused ? 'block' : 'none' }} />
            <canvas ref={trackingLayerRef} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }} />
            <div
                style={{
                    top: 0,
                    left: 0,
                    position: 'absolute',
                    width: '100%',
                    height: '100%'
                }}
            >
                {comps.finder && (
                    <Finder
                        scanning={isCameraActive}
                        capabilities={camera.capabilities}
                        loading={false}
                        onOff={comps.onOff}
                        torch={{
                            status: camera.torch,
                            toggle: comps.torch ? (val) => setTorchCached(val) : undefined
                        }}
                        startScanning={async () => await onCameraChange()}
                        stopScanning={async () => {
                            await camera.stopCamera();
                            clearCanvas(trackingLayerRef.current);
                            setIsCameraActive(false);
                        }}
                        border={styles?.finderBorder}
                    />
                )}
                {children}
            </div>
        </div>
    );
}
